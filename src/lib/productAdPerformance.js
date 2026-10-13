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
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

// Collapse ads that are the SAME creative: an identical Meta creative id, or an ad that is just a "- Copy" of another by name (Batch 10's name-copy rule).
function creativeGroupKey(ad, nameCopies) {
  const base = nameCopies && nameCopies.baseOf ? nameCopies.baseOf(ad.ad_name) : null;
  return ad.meta_creative_id ? `c:${ad.meta_creative_id}` : base ? `n:${base}` : `a:${ad.meta_ad_id}`;
}

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
  const rows = (await db.query(
    `SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.created_time, c.funnel,
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
      WHERE m.effective_status = 'ACTIVE' AND m.match_status IN ('confirmed', 'auto_matched') AND NOT COALESCE(cl.excluded_from_intelligence, false)
        AND NOT COALESCE((${dpaLib.dpaPredicate('m', 'c')}), false)
        AND EXISTS (SELECT 1 FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id AND p.product_code = ANY($1::text[]))
      GROUP BY m.meta_ad_id, m.ad_name, m.meta_creative_id, m.created_time, c.funnel, cl.concept_label, cl.creator_name, cl.creative_style_id, cl.media_type`,
    [codes, from, end, recentFrom, priorFrom, priorTo, fatFrom, fatPriorFrom, fatPriorTo, joinFrom])).rows;

  const per = new Map(); // familyKey -> Map(groupKey -> pooled)
  rows.forEach((r) => {
    const fams = [...new Set((r.product_codes || []).map((c) => codeToFamily.get(c)).filter(Boolean))];
    const shared = fams.length > 1;
    fams.forEach((fk) => {
      if (!per.has(fk)) per.set(fk, new Map());
      const g = per.get(fk); const key = creativeGroupKey(r, nameCopies);
      if (!g.has(key)) g.set(key, { key, ads: [], total: { spend: 0, impressions: 0, clicks: 0, purchases: 0, value: 0 }, recent: { spend: 0, impressions: 0, clicks: 0, purchases: 0, value: 0 }, prior: { spend: 0, impressions: 0, clicks: 0, purchases: 0, value: 0 }, fatigue_recent: { spend: 0, impressions: 0, clicks: 0, purchases: 0, value: 0 }, fatigue_prior: { spend: 0, impressions: 0, clicks: 0, purchases: 0, value: 0 }, delivery_rows: 0, funnels: new Set(), concept: null, creator: null, style: null, media: null, created: null, shared: false });
      const x = g.get(key);
      x.ads.push({ id: r.meta_ad_id, name: r.ad_name, shared });
      if (shared) x.shared = true;
      x.delivery_rows += r.delivery_rows;
      [['total', 't'], ['recent', 'r'], ['prior', 'p'], ['fatigue_recent', 'f'], ['fatigue_prior', 'g']].forEach(([w, p]) => { x[w].spend += num(r[`${p}_spend`]); x[w].impressions += num(r[`${p}_imp`]); x[w].clicks += num(r[`${p}_clk`]); x[w].purchases += num(r[`${p}_pur`]); x[w].value += num(r[`${p}_val`]); });
      if (r.funnel) x.funnels.add(r.funnel);
      x.concept = x.concept || r.concept_label || null; x.creator = x.creator || r.creator_name || null; x.style = x.style || r.creative_style_id || null; x.media = x.media || r.media_type || null;
      if (r.created_time && (!x.created || new Date(r.created_time) < new Date(x.created))) x.created = r.created_time;
    });
  });
  per.forEach((g, fk) => { if (nameCopies) mergeNameCopies(g, nameCopies); });
  per.forEach((g, fk) => {
    const entry = out.get(fk);
    g.forEach((x) => {
      const funnel = x.funnels.size === 1 ? [...x.funnels][0] : null; // a creative running in several funnels is not judged against one funnel's benchmark
      const verdict = judgeCreative({ total: x.total, recent: x.recent, prior: x.prior, fatigue_recent: x.fatigue_recent, fatigue_prior: x.fatigue_prior, delivery_rows: x.delivery_rows, funnel: JUDGED(funnel) }, { rules, coded, config: cfg });
      entry.creatives.push({ ...verdict, key: x.key, ads: x.ads, ad_count: x.ads.length, concept: x.concept, creator: x.creator, style_id: x.style, media: x.media, created: x.created, shared: x.shared, mixed_funnels: x.funnels.size > 1 });
    });
    entry.ads = [...g.values()].reduce((s, x) => s + x.ads.length, 0);
    entry.shared_ads = [...g.values()].reduce((s, x) => s + x.ads.filter((a) => a.shared).length, 0);
  });
  return out;
}

// A "- Copy" of an ad is the same creative even when Meta gave it its own creative id (Batch 10's name-copy rule): fold such a group into the group of the
// original ad (the one whose name equals the copy's base name). Pooled metrics are summed (they are different ads' spend, so nothing is counted twice).
function mergeNameCopies(groups, nameCopies) {
  const byName = new Map(); // normalised ad name -> group key
  groups.forEach((g, k) => g.ads.forEach((a) => { const nm = String(a.name || '').trim().toLowerCase(); if (nm && !byName.has(nm)) byName.set(nm, k); }));
  [...groups.keys()].forEach((k) => {
    const g = groups.get(k); if (!g) return;
    const copyAd = g.ads.find((a) => nameCopies.hasCopySuffix && nameCopies.hasCopySuffix(a.name));
    if (!copyAd) return;
    const baseKey = byName.get(String(nameCopies.baseOf(copyAd.name)).trim().toLowerCase());
    if (!baseKey || baseKey === k || !groups.has(baseKey)) return;
    const t = groups.get(baseKey);
    ['total', 'recent', 'prior', 'fatigue_recent', 'fatigue_prior'].forEach((w) => { Object.keys(t[w]).forEach((m) => { t[w][m] += g[w][m]; }); });
    t.ads.push(...g.ads); t.delivery_rows += g.delivery_rows; g.funnels.forEach((f) => t.funnels.add(f)); t.shared = t.shared || g.shared;
    t.concept = t.concept || g.concept; t.creator = t.creator || g.creator; t.style = t.style || g.style; t.media = t.media || g.media;
    if (g.created && (!t.created || new Date(g.created) < new Date(t.created))) t.created = g.created;
    groups.delete(k);
  });
}
const JUDGED = (f) => (['TOF', 'TOM', 'MOF'].includes(f) ? f : null);

module.exports = { mergeNameCopies, DEFAULTS, LIMITS, LABEL, resolveConfig, judgeCreative, summarizeProduct, loadProductAdPerformance, creativeGroupKey, cpaOf, roasOf, ctrOf };
