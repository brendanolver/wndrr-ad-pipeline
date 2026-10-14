// How well is a product's EXISTING Meta creative doing? -- the evidence behind "effective creative coverage".
//
// Having N active ads does not mean a product has enough creative: eight active ads of which six are clearly losing money is a product that needs
// fresh content, and ten strong ads is one that does not. This module judges each unique CREATIVE a product has running, from stored Meta insights,
// and rolls the verdicts up to the product.
//
// WHAT COUNTS (reliable at product level): spend, impressions, outbound clicks (CTR), purchases (CPA) and purchase value (ROAS). All of them ADD UP over
// days and over ads. Reach and Frequency do NOT (a person reached on two days is one person), so they are deliberately never summed here; the approved
// TOF Frequency benchmark stays on the Meta Performance page, where it is applied to an exact 3-5-day range.
//
// STATES (per creative):
//   performing      enough data, and an APPROVED benchmark says it is within target (today: MOF CPA <= the approved green limit)
//   underperforming enough data, and an approved benchmark says it is over target (orange = marginally, red = clearly)
//   declining       enough data in BOTH halves of the window, and it has clearly got worse than it was (relative to ITSELF, not a target): a fatigue signal
//   insufficient    not enough spend / delivery to judge. A low-spend ad with no purchases is NEVER called underperforming
//   unrated         enough data, but no approved benchmark applies (TOF / TOM CPA, ROAS ...) and no decline: shown, never coloured as good or bad
//   unavailable     no delivery data is stored for it at all
// Absolute judgements (performing / underperforming) come ONLY from the benchmarks in Settings (lib/metaBenchmarks.js): nothing is invented. A relative
// decline is a trend in the ad's own numbers and is worded as such, never as a target.
//
// A zero-purchase ad is judged only when its SPEND alone already exceeds the approved red limit (any CPA it could still reach is red); below that it is
// "insufficient". A weak result is also not proof the CREATIVE is the cause (audience, offer, landing page and product all matter): the wording everywhere
// is "worth testing new creative", never "this creative is bad".
const health = require('./metaFunnelHealth');
const dpaLib = require('./metaDpa'); // Dynamic Product Ads are not creative the team made for a product: never judged as its coverage

const DEFAULTS = {
  window_days: 14,          // evidence window (complete days, ending yesterday)
  trend_days: 7,            // recent half vs the half before it
  min_spend: 60,            // AUD over the window before a creative is judged (about one approved MOF CPA target of spend)
  min_impressions: 1000,
  min_trend_spend: 40,      // each half needs this spend before the two are compared
  trend_decline_pct: 25,    // a relative worsening this large is a "decline" (a trend threshold, NOT a performance target)
  min_performing_creatives: 3, // unique creatives that should be performing before coverage is called healthy (editable, provisional)
  // Batch 27: credible fatigue compares the last fatigue_days with the fatigue_days before (not 7-day halves), needs real delivery in BOTH, and never rests on CPA alone
  fatigue_days: 14,            // each side of the fatigue comparison
  fatigue_min_impressions: 10000, // impressions needed in each side (small samples swing)
  fatigue_min_purchases: 3,    // purchases needed in each side before CPA / ROAS are compared
};
const LIMITS = {
  window_days: [7, 60], trend_days: [3, 30], min_spend: [0, 5000], min_impressions: [0, 1000000], min_trend_spend: [0, 5000], trend_decline_pct: [5, 90], min_performing_creatives: [0, 50], fatigue_days: [7, 30], fatigue_min_impressions: [1000, 1000000], fatigue_min_purchases: [1, 100],
};
const LABEL = {
  window_days: 'Evidence window (days)', trend_days: 'Trend comparison (days per half)', min_spend: 'Minimum spend before judging an ad ($)', min_impressions: 'Minimum impressions before judging',
  min_trend_spend: 'Minimum spend in each half to compare trends ($)', trend_decline_pct: 'Decline that counts as fatigue (%)', min_performing_creatives: 'Performing creatives wanted per product', fatigue_days: 'Fatigue comparison (days per side)', fatigue_min_impressions: 'Minimum impressions in each fatigue side', fatigue_min_purchases: 'Minimum purchases in each fatigue side',
};

function resolveConfig(stored = {}) {
  const out = { ...DEFAULTS };
  const issues = [];
  Object.keys(DEFAULTS).forEach((k) => {
    if (stored && stored[k] === undefined) return;
    const v = Number(stored[k]);
    const [lo, hi] = LIMITS[k];
    if (!Number.isFinite(v) || v < lo || v > hi) { issues.push(`${k} must be between ${lo} and ${hi}`); return; }
    out[k] = v;
  });
  if (out.trend_days * 2 > out.window_days) { out.trend_days = Math.floor(out.window_days / 2); issues.push('trend_days was reduced so two halves fit in the window'); }
  return { config: out, issues };
}

const num = (v) => Number(v) || 0;
const money = (v) => `$${Math.round(v).toLocaleString('en-AU')}`;

// ratio helpers over a metrics bundle { spend, impressions, clicks, purchases, value }
const cpaOf = (m) => (num(m.purchases) > 0 ? num(m.spend) / num(m.purchases) : null);
const roasOf = (m) => (num(m.spend) > 0 && num(m.value) > 0 ? num(m.value) / num(m.spend) : null);
const ctrOf = (m) => (num(m.impressions) > 0 ? num(m.clicks) / num(m.impressions) : null);

// pure: judge ONE creative (metrics already pooled over its ads in the product).
//   m       { total: bundle, recent: bundle, prior: bundle, delivery_rows }   funnel 'TOF'|'TOM'|'MOF'|null
//   ctx     { rules, coded, config }  (rules / coded from metaBenchmarks.getEffective())
function judgeCreative({ total, recent, prior, fatigue_recent = null, fatigue_prior = null, delivery_rows = 0, funnel = null }, { rules = health.effectiveRules(), coded = health.COLOUR_CODED, config = DEFAULTS } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const reasons = [];
  const base = { funnel, spend: Math.round(num(total.spend) * 100) / 100, purchases: num(total.purchases), impressions: num(total.impressions), cpa: cpaOf(total), roas: roasOf(total), ctr: ctrOf(total) };
  if (!delivery_rows || (num(total.spend) <= 0 && num(total.impressions) <= 0)) {
    return { ...base, state: 'unavailable', reasons: ['No delivery was recorded for this creative in the evidence window, so it cannot be judged.'] };
  }
  if (num(total.spend) < cfg.min_spend || num(total.impressions) < cfg.min_impressions) {
    // the one exception: a zero-purchase creative whose spend ALONE already exceeds an approved red CPA limit (below)
    const earlyRed = num(total.purchases) === 0 && funnel && rules && health.classify(funnel, 'cpa', num(total.spend), {}, { rules, coded }) === 'red' && num(total.impressions) >= cfg.min_impressions;
    if (!earlyRed) {
      return { ...base, state: 'insufficient', reasons: [`Only ${money(total.spend)} spent and ${num(total.impressions).toLocaleString('en-AU')} impressions in the last ${cfg.window_days} days (judged from ${money(cfg.min_spend)} and ${cfg.min_impressions.toLocaleString('en-AU')}): not enough to judge.`] };
    }
  }
  // absolute judgement from the approved benchmark, if one applies to this funnel's CPA
  let cls = null; let basis = null;
  const cpa = cpaOf(total);
  if (funnel && rules) {
    if (cpa !== null) { cls = health.classify(funnel, 'cpa', cpa, {}, { rules, coded }); basis = cls ? `CPA ${money(cpa)}` : null; }
    else {
      // no purchases: any CPA it could still reach is >= its spend, so it is judged only if even that is red
      const lower = health.classify(funnel, 'cpa', num(total.spend), {}, { rules, coded });
      if (lower === 'red') { cls = 'red'; basis = `${money(total.spend)} spent with no purchase`; }
      else if (lower) return { ...base, state: 'insufficient', reasons: [`No purchase yet on ${money(total.spend)}: not enough spend to say it is over the approved ${funnel} CPA limit.`] };
    }
  }
  // relative trend: the creative against ITSELF (never a target), over two equal fatigue windows (default the last 14 days vs the 14 before; the 7-day halves are only a
  // fallback for callers that cannot supply them). Batch 27: a worsening is CREDIBLE FATIGUE only with real delivery in BOTH windows and corroboration. A CPA that
  // moved 25% while the ad is still within its approved benchmark is "softening" (shown, never counted against it), and CPA alone is never enough:
  //   credible = (CPA up or ROAS down) AND outbound CTR down      two independent indicators moving together
  //          or  (CPA up or ROAS down) AND it WAS within the benchmark and is now over it    the benchmark itself says it crossed the line
  const fr = fatigue_recent || recent || {}; const fp = fatigue_prior || prior || {};
  const pct = cfg.trend_decline_pct / 100;
  const enough = num(fr.spend) >= cfg.min_spend && num(fp.spend) >= cfg.min_spend && num(fr.impressions) >= cfg.fatigue_min_impressions && num(fp.impressions) >= cfg.fatigue_min_impressions;
  const buys = num(fr.purchases) >= cfg.fatigue_min_purchases && num(fp.purchases) >= cfg.fatigue_min_purchases;
  const rc = cpaOf(fr); const pc = cpaOf(fp); const rr = roasOf(fr); const pr = roasOf(fp); const rt = ctrOf(fr); const pt = ctrOf(fp);
  const cpaUp = enough && buys && rc !== null && pc !== null && rc >= pc * (1 + pct);
  const roasDown = enough && buys && rr !== null && pr !== null && rr <= pr * (1 - pct);
  const ctrDown = enough && rt !== null && pt !== null && rt <= pt * (1 - pct);
  const priorCls = funnel && rules && pc !== null ? health.classify(funnel, 'cpa', pc, {}, { rules, coded }) : null;
  const crossed = priorCls === 'green' && (cls === 'orange' || cls === 'red');
  const spendSignals = [];
  if (cpaUp) spendSignals.push(`CPA rose from ${money(pc)} to ${money(rc)} (up ${Math.round((rc / pc - 1) * 100)}%)`);
  if (roasDown) spendSignals.push(`ROAS fell from ${pr.toFixed(2)} to ${rr.toFixed(2)} (down ${Math.round((1 - rr / pr) * 100)}%)`);
  if (ctrDown) spendSignals.push(`outbound CTR fell from ${(pt * 100).toFixed(2)}% to ${(rt * 100).toFixed(2)}%`);
  const trend = { days: fatigue_recent ? cfg.fatigue_days : cfg.trend_days, enough_delivery: enough, enough_purchases: buys, cpa_up: cpaUp, roas_down: roasDown, ctr_down: ctrDown, crossed_benchmark: crossed, signals: spendSignals, credible_fatigue: false, softening: false };
  if ((cpaUp || roasDown) && (ctrDown || crossed)) {
    trend.credible_fatigue = true;
    reasons.push(`Credible fatigue: ${spendSignals.join('; ')} (last ${trend.days} days vs the ${trend.days} before, with enough delivery in both). ${crossed ? `It was within the approved ${funnel} CPA limit before and is now ${cls === 'red' ? 'over' : 'marginally over'} it.` : 'Two independent indicators worsened together.'}`);
    return { ...base, state: 'declining', severity: cls === 'red' ? 'clear' : cls === 'orange' ? 'marginal' : 'relative', decline: { signals: spendSignals }, benchmark: cls, trend, reasons };
  }
  if (spendSignals.length) {
    trend.softening = true;
    reasons.push(`Softening, not fatigue: ${spendSignals.join('; ')}. ${cls === 'green' ? 'It is still within the approved benchmark, so it still counts as performing.' : 'There is no second indicator or benchmark crossing, so it is not called fatigued.'}`);
  }
  if (cls === 'green') return { ...base, state: 'performing', benchmark: 'green', trend, reasons: [`${basis}: within the approved ${funnel} CPA limit.`, ...reasons] };
  if (cls === 'orange') return { ...base, state: 'underperforming', severity: 'marginal', benchmark: 'orange', trend, reasons: [`${basis}: marginally over the approved ${funnel} CPA limit.`, ...reasons] };
  if (cls === 'red') return { ...base, state: 'underperforming', severity: 'clear', benchmark: 'red', trend, reasons: [`${basis}: over the approved ${funnel} CPA limit.`, ...reasons] };
  reasons.push(funnel ? `Enough data (${money(total.spend)} spent), but there is no approved ${funnel} CPA benchmark, so it is neither called good nor bad.` : 'Enough data, but its funnel (TOF / TOM / MOF) is unknown or mixed, so no approved benchmark applies.');
  return { ...base, state: 'unrated', trend, reasons };
}

// pure: roll creatives up to a product.  creatives: [{ key, state, ads: n, ... }]; pending: active ads awaiting review (Batch 11 uncertainty)
function summarizeProduct(creatives, { pendingAds = 0, minPerforming = DEFAULTS.min_performing_creatives, activeAds = null } = {}) {
  const c = { performing: 0, underperforming: 0, declining: 0, insufficient: 0, unrated: 0, unavailable: 0 };
  creatives.forEach((x) => { c[x.state] = (c[x.state] || 0) + 1; });
  const total = creatives.length;
  const judged = c.performing + c.underperforming + c.declining;
  const weak = c.underperforming + c.declining;
  const clearWeak = creatives.filter((x) => (x.state === 'underperforming' || x.state === 'declining') && x.severity !== 'marginal').length;
  const gap = Math.max(0, minPerforming - c.performing);
  const evidence = total === 0 ? 'none' : judged >= 2 || (judged >= 1 && total <= 2) ? 'good' : 'thin';
  let assessment; let text;
  if (total === 0) { assessment = 'no_creative'; text = 'No unique creative is running for this product.'; }
  else if (evidence === 'thin' && c.performing < minPerforming) { assessment = 'unclear'; text = `Only ${judged} of ${total} unique creatives have enough data to judge, so effective coverage is unclear.`; }
  else if (c.performing >= minPerforming && weak <= c.performing) { assessment = 'healthy'; text = `${c.performing} of ${total} unique creatives are performing against the approved benchmark.`; }
  else if (c.performing >= minPerforming) { assessment = 'mixed'; text = `${c.performing} performing, but ${weak} weak or fading (of ${total}).`; }
  else { assessment = 'thin'; text = `${c.performing} of ${total} unique creatives are performing (${minPerforming} wanted)${weak ? `; ${weak} weak or fading` : ''}.`; }
  return {
    active_ads: activeAds, unique_creatives: total, ...c, judged, weak, clear_weak: clearWeak, performing_gap: gap, evidence, assessment, text,
    pending_review_ads: pendingAds, uncertain: pendingAds > 0,
    weak_share: judged ? Math.round((weak / judged) * 100) : null,
  };
}

// ── loader ──────────────────────────────────────────────────────────────────────────────────────
const ymdOf = (d) => d.toISOString().slice(0, 10);
const zeroBundle = () => ({ spend: 0, impressions: 0, clicks: 0, purchases: 0, value: 0 });
const newPool = () => ({ total: zeroBundle(), recent: zeroBundle(), prior: zeroBundle(), fatigue_recent: zeroBundle(), fatigue_prior: zeroBundle(), delivery_rows: 0 });
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

// Collapse ads that are the SAME creative: an identical Meta creative id, or an ad that is just a "- Copy" of another by name (Batch 10's name-copy rule).
function creativeGroupKey(ad, nameCopies) {
  const base = nameCopies && nameCopies.baseOf ? nameCopies.baseOf(ad.ad_name) : null;
  return ad.meta_creative_id ? `c:${ad.meta_creative_id}` : base ? `n:${base}` : `a:${ad.meta_ad_id}`;
}

// The ONE query that turns Meta ads into per-ad evidence rows (windows end yesterday). `cond` is the WHERE condition and may use $1 (a text[] of product codes). Parameters $2..$10 are the windows.
function adRowsSql(cond) {
  return `SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.effective_status, m.created_time, c.funnel, cl.concept_type_id,
            (SELECT to_char(MIN(x.insight_date), 'YYYY-MM-DD') FROM meta_ad_insights_daily x WHERE x.meta_ad_id = m.meta_ad_id AND (x.spend > 0 OR x.impressions > 0)) AS first_day,
            (SELECT to_char(MAX(x.insight_date), 'YYYY-MM-DD') FROM meta_ad_insights_daily x WHERE x.meta_ad_id = m.meta_ad_id AND (x.spend > 0 OR x.impressions > 0)) AS last_day,
            (SELECT COALESCE(SUM(x.spend), 0) FROM meta_ad_insights_daily x WHERE x.meta_ad_id = m.meta_ad_id) AS life_spend,
            cl.concept_label, cl.creator_name, cl.creative_style_id, cl.media_type,
            (SELECT array_agg(DISTINCT p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id) AS product_codes,
            COUNT(d.meta_ad_id) FILTER (WHERE d.insight_date >= $2)::int AS delivery_rows,
            COALESCE(SUM(d.spend) FILTER (WHERE d.insight_date >= $2),0) AS t_spend, COALESCE(SUM(d.impressions) FILTER (WHERE d.insight_date >= $2),0) AS t_imp, COALESCE(SUM(d.outbound_clicks) FILTER (WHERE d.insight_date >= $2),0) AS t_clk, COALESCE(SUM(d.purchases) FILTER (WHERE d.insight_date >= $2),0) AS t_pur, COALESCE(SUM(d.purchase_value) FILTER (WHERE d.insight_date >= $2),0) AS t_val,
            COALESCE(SUM(d.spend) FILTER (WHERE d.insight_date >= $7),0) AS f_spend, COALESCE(SUM(d.impressions) FILTER (WHERE d.insight_date >= $7),0) AS f_imp, COALESCE(SUM(d.outbound_clicks) FILTER (WHERE d.insight_date >= $7),0) AS f_clk,
            COALESCE(SUM(d.purchases) FILTER (WHERE d.insight_date >= $7),0) AS f_pur, COALESCE(SUM(d.purchase_value) FILTER (WHERE d.insight_date >= $7),0) AS f_val,
            COALESCE(SUM(d.spend) FILTER (WHERE d.insight_date BETWEEN $8 AND $9),0) AS g_spend, COALESCE(SUM(d.impressions) FILTER (WHERE d.insight_date BETWEEN $8 AND $9),0) AS g_imp, COALESCE(SUM(d.outbound_clicks) FILTER (WHERE d.insight_date BETWEEN $8 AND $9),0) AS g_clk,
            COALESCE(SUM(d.purchases) FILTER (WHERE d.insight_date BETWEEN $8 AND $9),0) AS g_pur, COALESCE(SUM(d.purchase_value) FILTER (WHERE d.insight_date BETWEEN $8 AND $9),0) AS g_val,
            COALESCE(SUM(d.spend) FILTER (WHERE d.insight_date >= $4),0) AS r_spend, COALESCE(SUM(d.impressions) FILTER (WHERE d.insight_date >= $4),0) AS r_imp, COALESCE(SUM(d.outbound_clicks) FILTER (WHERE d.insight_date >= $4),0) AS r_clk,
            COALESCE(SUM(d.purchases) FILTER (WHERE d.insight_date >= $4),0) AS r_pur, COALESCE(SUM(d.purchase_value) FILTER (WHERE d.insight_date >= $4),0) AS r_val,
            COALESCE(SUM(d.spend) FILTER (WHERE d.insight_date BETWEEN $5 AND $6),0) AS p_spend, COALESCE(SUM(d.impressions) FILTER (WHERE d.insight_date BETWEEN $5 AND $6),0) AS p_imp, COALESCE(SUM(d.outbound_clicks) FILTER (WHERE d.insight_date BETWEEN $5 AND $6),0) AS p_clk,
            COALESCE(SUM(d.purchases) FILTER (WHERE d.insight_date BETWEEN $5 AND $6),0) AS p_pur, COALESCE(SUM(d.purchase_value) FILTER (WHERE d.insight_date BETWEEN $5 AND $6),0) AS p_val
       FROM meta_ads m
       LEFT JOIN meta_ad_classifications cl ON cl.meta_ad_id = m.meta_ad_id
       LEFT JOIN meta_campaigns c ON c.meta_campaign_id = m.meta_campaign_id
       LEFT JOIN meta_ad_insights_daily d ON d.meta_ad_id = m.meta_ad_id AND d.insight_date BETWEEN $10 AND $3
      WHERE ${cond}
      GROUP BY m.meta_ad_id, m.ad_name, m.meta_creative_id, m.effective_status, m.created_time, c.funnel, cl.concept_type_id, cl.concept_label, cl.creator_name, cl.creative_style_id, cl.media_type`;
}
const ACTIVE_PRODUCT_COND = `m.effective_status = 'ACTIVE' AND m.match_status IN ('confirmed', 'auto_matched') AND NOT COALESCE(cl.excluded_from_intelligence, false)
        AND NOT COALESCE((${dpaLib.dpaPredicate('m', 'c')}), false)
        AND EXISTS (SELECT 1 FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id AND p.product_code = ANY($1::text[]))`;

// → Map(familyKey -> { creatives: [verdict + {key, ads[], names, concept, creator, style, media, first_spend, created}], ads: n, shared_ads: n, summary })
async function loadProductAdPerformance(families, { db, rules, coded, config = DEFAULTS, today, nameCopies = null } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const end = addDays(today, -1);
  const recentFrom = addDays(end, -(cfg.trend_days - 1));
  const priorTo = addDays(recentFrom, -1);
  const priorFrom = addDays(priorTo, -(cfg.trend_days - 1));
  const from = addDays(end, -(cfg.window_days - 1));
  const fatFrom = addDays(end, -(cfg.fatigue_days - 1));      // the last fatigue_days ...
  const fatPriorTo = addDays(fatFrom, -1);
  const fatPriorFrom = addDays(fatPriorTo, -(cfg.fatigue_days - 1)); // ... and the same number of days before them
  const joinFrom = fatPriorFrom < from ? fatPriorFrom : from;
  const codeToFamily = new Map();
  families.forEach((f) => (f.codes || [f.key]).forEach((c) => codeToFamily.set(c, f.key)));
  const codes = [...codeToFamily.keys()];
  const out = new Map(); families.forEach((f) => out.set(f.key, { creatives: [], ads: 0, shared_ads: 0 }));
  if (!codes.length) return out;
  const rows = (await db.query(adRowsSql(ACTIVE_PRODUCT_COND), [codes, from, end, recentFrom, priorFrom, priorTo, fatFrom, fatPriorFrom, fatPriorTo, joinFrom])).rows;

  // The earliest day with any stored delivery for ANY ad. A first-delivery date on that day may only be where the stored history begins, so it is never trusted to mean "just started".
  let horizon = null; let newestDay = null;
  try { const h = (await db.query("SELECT to_char(MIN(insight_date), 'YYYY-MM-DD') AS d, to_char(MAX(insight_date), 'YYYY-MM-DD') AS n FROM meta_ad_insights_daily")).rows[0] || {}; horizon = h.d || null; newestDay = h.n || null; } catch (e) { horizon = null; newestDay = null; }
  const per = new Map(); // familyKey -> Map(groupKey -> pooled)
  rows.forEach((r) => {
    const fams = [...new Set((r.product_codes || []).map((c) => codeToFamily.get(c)).filter(Boolean))];
    const shared = fams.length > 1;
    fams.forEach((fk) => {
      if (!per.has(fk)) per.set(fk, new Map());
      const g = per.get(fk); const key = creativeGroupKey(r, nameCopies);
      if (!g.has(key)) g.set(key, newGroup(key));
      addRowToGroup(g.get(key), r, shared);
    });
  });
  per.forEach((g, fk) => { if (nameCopies) { mergeNameCopies(g, nameCopies); mergeCopySiblings(g, nameCopies); } });
  const allGroups = []; per.forEach((g) => g.forEach((x) => allGroups.push(x)));
  const origins = await loadCreativeOrigins(db, allGroups, nameCopies);
  origins.forEach((o, x) => {
    x.instances_total = o.instances;
    if (o.first_day && (!x.first_day || o.first_day < x.first_day)) { x.first_day = o.first_day; x.first_delivery_from_other_instance = true; }
    if (o.created && (!x.created || new Date(o.created) < new Date(x.created))) x.created = o.created;
    if (o.undated_created) x.origin_created_undated = o.undated_created;
  });
  per.forEach((g, fk) => {
    const entry = out.get(fk);
    g.forEach((x) => {
      const verdict = judgeAcrossFunnels(x, { rules, coded, cfg });
      // dates: created = the ad's creation date in Meta; first_delivery / last_delivery = the first and last day with STORED delivery (spend or impressions); lifetime_spend = all stored days.
      // A creation date is not a start date, and a first stored delivery on the first day we hold data may only be where our history begins (first_delivery_truncated).
      entry.creatives.push({ ...verdict, key: x.key, name: (x.ads[0] && x.ads[0].name) || null, ads: x.ads, ad_count: x.ads.length, concept: x.concept, creator: x.creator, style_id: x.style, media: x.media, created: x.created, shared: x.shared, mixed_funnels: x.pools.size > 1,
        first_delivery: x.first_day || null, last_delivery: x.last_day || null, instances_total: x.instances_total || x.ads.length, first_delivery_from_other_instance: !!x.first_delivery_from_other_instance, origin_created_undated: x.origin_created_undated || null, lifetime_spend: Math.round(num(x.life_spend) * 100) / 100, first_delivery_truncated: !!(x.first_day && horizon && x.first_day <= horizon), funnel_label: [...x.funnels].join(' / ') || null });
    });
    entry.insights_last_day = newestDay; // the newest day with ANY stored delivery: whether delivery can be judged at all (Live Ads)
    entry.ads = [...g.values()].reduce((s, x) => s + x.ads.length, 0);
    entry.shared_ads = [...g.values()].reduce((s, x) => s + x.ads.filter((a) => a.shared).length, 0);
  });
  return out;
}

// ONE creative, judged within each funnel it ran in (Batch 30). With a single funnel this is exactly judgeCreative. With several, each funnel's pooled metrics are judged
// against THAT funnel's approved benchmark and the creative's verdict is taken from its most informative funnel: rated (performing / underperforming / declining) before
// unrated before insufficient before no-delivery, the funnel with the most spend winning a tie. Every funnel's own result stays in `funnel_results`. The creative is never
// "unrated" merely because it also ran in a funnel with no benchmark, and one funnel's result never overrides another funnel's evidence in the totals.
const VERDICT_RANK = { performing: 0, underperforming: 0, declining: 0, unrated: 1, insufficient: 2, unavailable: 3 };
function judgeAcrossFunnels(x, { rules, coded, cfg }) {
  const results = [...x.pools.entries()].map(([fk, pool]) => {
    const funnel = JUDGED(fk);
    const v = judgeCreative({ total: pool.total, recent: pool.recent, prior: pool.prior, fatigue_recent: pool.fatigue_recent, fatigue_prior: pool.fatigue_prior, delivery_rows: pool.delivery_rows, funnel }, { rules, coded, config: cfg });
    return { funnel_key: fk, funnel, verdict: v };
  });
  if (results.length <= 1) {
    const only = results[0] || { verdict: judgeCreative({ total: x.total, recent: x.recent, prior: x.prior, delivery_rows: x.delivery_rows, funnel: null }, { rules, coded, config: cfg }) };
    return { ...only.verdict, funnel_results: results.map((r) => funnelResult(r)) };
  }
  const ranked = results.slice().sort((a, b) => (VERDICT_RANK[a.verdict.state] - VERDICT_RANK[b.verdict.state]) || (num(b.verdict.spend) - num(a.verdict.spend)));
  const primary = ranked[0].verdict;
  return {
    ...primary,
    spend: Math.round(num(x.total.spend) * 100) / 100, purchases: num(x.total.purchases), impressions: num(x.total.impressions),
    funnel_results: ranked.map((r) => funnelResult(r)),
    reasons: [`Judged in its ${ranked[0].funnel_key} funnel (${num(primary.spend) > 0 ? money(primary.spend) : 'no'} spend there); it also ran in ${ranked.slice(1).map((r) => r.funnel_key).join(' and ')}, each judged against its own funnel benchmark.`, ...(primary.reasons || [])],
  };
}
function funnelResult(r) {
  const v = r.verdict;
  return { funnel: r.funnel_key, benchmarked: !!(r.funnel && v.state !== 'unrated' && v.state !== 'insufficient' && v.state !== 'unavailable'), state: v.state, benchmark: v.benchmark || null, spend: v.spend, purchases: v.purchases, impressions: v.impressions, cpa: v.cpa, roas: v.roas, ctr: v.ctr, value: Math.round(num(v.roas) * num(v.spend) * 100) / 100, reason: (v.reasons || [])[0] || null };
}

// ONE creative as a pool of Meta ads (any number of campaigns / ad sets): the account's single definition of "a unique creative". Shared by Planning (per product) and Creative Insights (account-wide).
function newGroup(key) {
  return { key, ads: [], total: zeroBundle(), recent: zeroBundle(), prior: zeroBundle(), fatigue_recent: zeroBundle(), fatigue_prior: zeroBundle(), delivery_rows: 0, funnels: new Set(), pools: new Map(), concept: null, creator: null, style: null, media: null, created: null, shared: false };
}
// r: one ad row as the loaders' queries return it (meta_ad_id, ad_name, funnel, first_day, last_day, life_spend, concept_label, creator_name, creative_style_id, media_type, delivery_rows, t_* r_* p_* f_* g_* metrics)
function addRowToGroup(x, r, shared = false) {
  x.ads.push({ id: r.meta_ad_id, name: r.ad_name, shared, status: r.effective_status || null, creative_id: r.meta_creative_id || null });
  if (shared) x.shared = true;
  x.delivery_rows += r.delivery_rows;
  // Batch 30: the SAME creative running in several funnels stays ONE creative, but each funnel keeps its own pooled metrics so it is judged against that funnel's benchmark
  const fnl = r.funnel || 'unknown';
  if (!x.pools.has(fnl)) x.pools.set(fnl, newPool());
  const pool = x.pools.get(fnl);
  pool.delivery_rows += r.delivery_rows;
  [['total', 't'], ['recent', 'r'], ['prior', 'p'], ['fatigue_recent', 'f'], ['fatigue_prior', 'g']].forEach(([w, p]) => { [x, pool].forEach((tgt) => { tgt[w].spend += num(r[`${p}_spend`]); tgt[w].impressions += num(r[`${p}_imp`]); tgt[w].clicks += num(r[`${p}_clk`]); tgt[w].purchases += num(r[`${p}_pur`]); tgt[w].value += num(r[`${p}_val`]); }); });
  if (r.funnel) x.funnels.add(r.funnel);
  if (r.first_day && (!x.first_day || r.first_day < x.first_day)) x.first_day = r.first_day;
  if (r.last_day && (!x.last_day || r.last_day > x.last_day)) x.last_day = r.last_day;
  x.life_spend = (x.life_spend || 0) + num(r.life_spend);
  x.concept = x.concept || r.concept_label || null; x.creator = x.creator || r.creator_name || null; x.style = x.style || r.creative_style_id || null; x.media = x.media || r.media_type || null;
  if (r.created_time && (!x.created || new Date(r.created_time) < new Date(x.created))) x.created = r.created_time;
}

// WHEN did a unique creative really start? (Batch 31) Planning only loads the ads that are ACTIVE and matched, but a duplicate of an old creative (into another campaign or ad set)
// is a new Meta AD, not a new CREATIVE. If the original instance is paused, archived or not yet reviewed it is not in the group, and the group's first delivery would be the duplicate's:
// a creative that has run for weeks would be called "early testing". This looks up EVERY instance of the same creative identity (an identical Meta creative id, or the "- Copy" name rule, whatever
// the status or match state) and returns the earliest stored delivery day and creation date. It never adds an ad to a group, so unique-creative counts and the performance judged are unchanged.
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
async function loadCreativeOrigins(db, groups, nameCopies) {
  const ids = new Set(); const pats = new Set();
  groups.forEach((g) => g.ads.forEach((a) => {
    if (a.creative_id) ids.add(String(a.creative_id));
    if (nameCopies && nameCopies.hasCopySuffix && nameCopies.hasCopySuffix(a.name) && a.name) pats.add(`${likeEscape(nameCopies.baseOf(a.name))}%`);
  }));
  const out = new Map();
  if (!ids.size && !pats.size) return out;
  let rows = [];
  try {
    rows = (await db.query(
      `/* creative-origins */ SELECT m.meta_ad_id, m.meta_creative_id, m.ad_name, m.created_time,
              (SELECT to_char(MIN(x.insight_date), 'YYYY-MM-DD') FROM meta_ad_insights_daily x WHERE x.meta_ad_id = m.meta_ad_id AND (x.spend > 0 OR x.impressions > 0)) AS first_day
         FROM meta_ads m WHERE m.meta_creative_id = ANY($1::text[]) OR m.ad_name ILIKE ANY($2::text[])`, [[...ids], [...pats]])).rows;
  } catch (e) { return out; } // never blocks Planning: without it the creative is dated from the instances that are loaded (as before)
  groups.forEach((g) => {
    const gids = new Set(g.ads.map((a) => a.creative_id).filter(Boolean).map(String));
    const hasCopy = !!(nameCopies && nameCopies.hasCopySuffix && g.ads.some((a) => nameCopies.hasCopySuffix(a.name)));
    const bases = new Set(hasCopy ? g.ads.map((a) => nameCopies.baseOf(a.name)) : []);
    const mine = rows.filter((c) => (c.meta_creative_id && gids.has(String(c.meta_creative_id))) || (hasCopy && bases.has(nameCopies.baseOf(c.ad_name))));
    if (!mine.length) return;
    let first = null; let created = null;
    mine.forEach((c) => {
      if (c.first_day && (!first || c.first_day < first)) first = c.first_day;
      if (c.created_time && (!created || new Date(c.created_time) < new Date(created))) created = c.created_time;
    });
    // an earlier-created instance that has NO stored delivery cannot be dated: it is disclosed, and the creative is not called new
    const undated = mine.filter((c) => !c.first_day && c.created_time && (!first || new Date(c.created_time).toISOString().slice(0, 10) < first)).map((c) => new Date(c.created_time));
    out.set(g, { instances: mine.length, first_day: first, created, undated_created: undated.length ? new Date(Math.min(...undated.map((d) => d.getTime()))) : null });
  });
  return out;
}

// A "- Copy" of an ad is the same creative even when Meta gave it its own creative id (Batch 10's name-copy rule): fold such a group into the group of the
// original ad (the one whose name equals the copy's base name). Pooled metrics are summed (they are different ads' spend, so nothing is counted twice).
// Folds group g into group t: pooled metrics are summed per funnel (different ads' spend, so nothing is counted twice), ads and dates are combined.
function foldGroup(t, g) {
  ['total', 'recent', 'prior', 'fatigue_recent', 'fatigue_prior'].forEach((w) => { Object.keys(t[w]).forEach((m) => { t[w][m] += g[w][m]; }); });
  t.ads.push(...g.ads); t.delivery_rows += g.delivery_rows; g.funnels.forEach((f) => t.funnels.add(f)); t.shared = t.shared || g.shared;
  g.pools.forEach((gp, fk) => { if (!t.pools.has(fk)) t.pools.set(fk, newPool()); const tp = t.pools.get(fk); tp.delivery_rows += gp.delivery_rows; ['total', 'recent', 'prior', 'fatigue_recent', 'fatigue_prior'].forEach((w) => { Object.keys(tp[w]).forEach((m) => { tp[w][m] += gp[w][m]; }); }); });
  t.concept = t.concept || g.concept; t.creator = t.creator || g.creator; t.style = t.style || g.style; t.media = t.media || g.media;
  if (g.created && (!t.created || new Date(g.created) < new Date(t.created))) t.created = g.created;
  if (g.first_day && (!t.first_day || g.first_day < t.first_day)) t.first_day = g.first_day;
  if (g.last_day && (!t.last_day || g.last_day > t.last_day)) t.last_day = g.last_day;
  t.life_spend = (t.life_spend || 0) + (g.life_spend || 0);
}

// A "- Copy" of an ad is the same creative even when Meta gave it its own creative id (Batch 10's name-copy rule): fold such a group into the group of the
// original ad (the one whose name equals the copy's base name).
function mergeNameCopies(groups, nameCopies) {
  const byName = new Map(); // normalised ad name -> group key
  groups.forEach((g, k) => g.ads.forEach((a) => { const nm = String(a.name || '').trim().toLowerCase(); if (nm && !byName.has(nm)) byName.set(nm, k); }));
  [...groups.keys()].forEach((k) => {
    const g = groups.get(k); if (!g) return;
    const copyAd = g.ads.find((a) => nameCopies.hasCopySuffix && nameCopies.hasCopySuffix(a.name));
    if (!copyAd) return;
    const baseKey = byName.get(String(nameCopies.baseOf(copyAd.name)).trim().toLowerCase());
    if (!baseKey || baseKey === k || !groups.has(baseKey)) return;
    foldGroup(groups.get(baseKey), g);
    groups.delete(k);
  });
}

// Batch 33. mergeNameCopies only folds a copy into an ORIGINAL that is itself in the set. When the original is not (paused, archived, or never matched to the product) the copies
// ("X - Copy", "X - Copy 2", "X - Copy - Copy", ...), each with its own Meta creative id, stayed separate creatives: one execution counted four times. This also folds the copies
// that share the same canonical name with each other (and with a plain-named original when present). Only a recognised TRAILING duplicate suffix counts (metaNameCopies), the
// remainder must match exactly (case aside), and two ads with identical names but no suffix are never merged. Planning only: Creative Insights keeps calling mergeNameCopies.
function mergeCopySiblings(groups, nameCopies) {
  if (!nameCopies || !nameCopies.hasCopySuffix) return;
  const norm = (n) => String(n || '').trim().toLowerCase();
  const bases = new Set();
  groups.forEach((g) => g.ads.forEach((a) => { if (a.name && nameCopies.hasCopySuffix(a.name)) bases.add(norm(nameCopies.baseOf(a.name))); }));
  if (!bases.size) return;
  const buckets = new Map(); // canonical name -> first group key
  [...groups.keys()].forEach((k) => {
    const g = groups.get(k); if (!g) return;
    const suffixed = g.ads.find((a) => a.name && nameCopies.hasCopySuffix(a.name));
    const key = suffixed ? norm(nameCopies.baseOf(suffixed.name)) : (g.ads.map((a) => norm(a.name)).find((n) => n && bases.has(n)) || null);
    if (!key) return;
    if (!buckets.has(key)) { buckets.set(key, k); return; }
    const t = groups.get(buckets.get(key)); if (!t || t === g) return;
    foldGroup(t, g); groups.delete(k);
  });
}
const JUDGED = (f) => (['TOF', 'TOM', 'MOF'].includes(f) ? f : null);

module.exports = { adRowsSql, newGroup, addRowToGroup, judgeAcrossFunnels, mergeNameCopies, mergeCopySiblings, DEFAULTS, LIMITS, LABEL, resolveConfig, judgeCreative, summarizeProduct, loadProductAdPerformance, creativeGroupKey, cpaOf, roasOf, ctrOf };
