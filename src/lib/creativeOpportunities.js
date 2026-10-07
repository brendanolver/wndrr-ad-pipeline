// Creative Opportunities V1 -- "What creative should WNDRR make next, and why?"
//
// A deterministic, explainable recommendation layer computed ON READ from
// data that already lives in the local database:
//
//   meta_ads + meta_ad_insights_daily + meta_ad_classifications +
//   meta_ad_products          Meta spend / purchases / ATC / outbound CTR per
//                             classified ad, and what each ad IS (product,
//                             concept, creator, media type)
//   styles / creative_assets /
//   status_history            product families and WNDRR's own creative dates
//   ApparelMagic sales +
//   Report Pipeline tiers     demand (the same signals Core / High Stock use)
//
// No Meta call is made here (nothing in this file imports metaAds.js), no
// sync behaviour or canonical metric definition is touched, and nothing is
// written except the human dismiss / acted-on decisions
// (creative_opportunity_states). Every threshold is in
// creativeOpportunitiesConfig.js.
//
// ── DATA QUALITY (explicit) ─────────────────────────────────────────────
// ONLY ads whose match_status is 'confirmed' (a person) or 'auto_matched'
// contribute -- see INCLUDED_ADS_SQL. 'unmatched' and 'suggested' (Needs
// review) ads, ads excluded from intelligence, and "not product-specific"
// ads never contribute to any figure, count or recommendation.
//
// ── MULTI-PRODUCT ATTRIBUTION RULE ──────────────────────────────────────
// An ad classified to N products (a set / bundle) is shared, never assigned
// to one product silently and never counted in full N times:
//   * MONEY / VOLUME (spend, purchases, add-to-cart, outbound clicks,
//     impressions) is split EQUALLY: each product receives 1/N. Totals across
//     products therefore add back up to the ad's real figures, and CPA / CTR
//     (ratios of two split numbers) equal the ad's own.
//   * PRESENCE (is this a creative / concept / creator / media the product
//     has run? newest creative date?) counts for every product in the ad,
//     because the creative genuinely featured each of them; the evidence
//     drawer flags such ads as "shared with N-1 other products".
//   * A product only counts as "used on" a concept at the account level when
//     its allocated (split) spend clears CONCEPT.min_product_spend, so a set
//     ad cannot make a concept look proven across many products on its own.
// Windows end YESTERDAY (Sydney): today's partial day would make
// recommendations move between refreshes.
const { pool } = require('../db');
const cfg = require('./creativeOpportunitiesConfig');
const { ymdInZone, addDays, REPORTING_TIMEZONE, deriveMetrics, HttpError } = require('./metaPerformance');
const { deriveProductCode } = require('./apparelmagic');
const { MEDIA_LABEL } = require('./metaNameParsing');

// The data-quality gate, in one place.
const INCLUDED_ADS_SQL = `
  m.match_status IN ('confirmed', 'auto_matched')
  AND NOT COALESCE(c.excluded_from_intelligence, false)
  AND NOT COALESCE(c.not_product_specific, false)`;

// ── small pure helpers ──────────────────────────────────────────────────
const num = (v) => Number(v) || 0;
const ratio = (a, b) => (b > 0 ? a / b : null);
const round = (v, d = 2) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
const METRIC_KEYS = ['spend', 'impressions', 'purchases', 'add_to_cart', 'outbound_clicks'];
const zero = () => ({ spend: 0, impressions: 0, purchases: 0, add_to_cart: 0, outbound_clicks: 0 });
function addInto(acc, m, f = 1) { METRIC_KEYS.forEach((k) => { acc[k] += num(m[k]) * f; }); return acc; }
function daysBetween(fromYmd, toYmd) {
  const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(toYmd) - p(fromYmd)) / 86400000);
}
const money = (v) => `$${Math.round(num(v)).toLocaleString('en-AU')}`;
const pct = (v) => `${Math.round(v * 100)}%`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const ageText = (days) => (days >= 60 ? `${Math.round(days / 30)} months` : plural(days, 'day'));
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const priorityRank = (p) => cfg.PRIORITY_RANK[p] || 0;

// Freshness band for "days since the product's newest creative".
// null (nothing on record) is Very stale by definition.
function freshnessBand(days) {
  const f = cfg.FRESHNESS;
  if (days === null || days === undefined) return { band: 'very_stale', label: 'Very stale', none: true };
  if (days < f.fresh_lt) return { band: 'fresh', label: 'Fresh' };
  if (days < f.aging_lt) return { band: 'aging', label: 'Aging' };
  if (days < f.stale_lt) return { band: 'stale', label: 'Stale' };
  return { band: 'very_stale', label: 'Very stale' };
}

// ── windows (end yesterday, Sydney) ─────────────────────────────────────
function buildWindows(now = new Date()) {
  const today = ymdInZone(now, REPORTING_TIMEZONE);
  const until = addDays(today, -1);
  const w = cfg.WINDOWS;
  return {
    today,
    until,
    evidence: { since: addDays(until, -(w.evidence_days - 1)), until },
    recent: { since: addDays(until, -(w.recent_days - 1)), until },
    fatigueRecent: { since: addDays(until, -(w.fatigue_days - 1)), until },
    fatiguePrior: { since: addDays(until, -(2 * w.fatigue_days - 1)), until: addDays(until, -w.fatigue_days) },
  };
}

// ── data loading (local DB only) ────────────────────────────────────────
async function loadSnapshot(now = new Date(), db = pool) {
  const win = buildWindows(now);
  const adsRes = await db.query(
    `SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.effective_status, m.match_status, m.created_time,
            c.concept_type_id, c.concept_label, c.creator_name, c.media_type,
            COALESCE(json_agg(json_build_object('code', p.product_code, 'name', p.product_name) ORDER BY p.product_code)
                     FILTER (WHERE p.product_code IS NOT NULL), '[]') AS products
       FROM meta_ads m
       JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
       LEFT JOIN meta_ad_products p ON p.meta_ad_id = m.meta_ad_id
      WHERE ${INCLUDED_ADS_SQL}
      GROUP BY m.meta_ad_id, m.ad_name, m.meta_creative_id, m.effective_status, m.match_status, m.created_time,
               c.concept_type_id, c.concept_label, c.creator_name, c.media_type
     HAVING count(p.product_code) > 0`
  );
  const ids = adsRes.rows.map((r) => r.meta_ad_id);

  const windows = { e: win.evidence, m: win.recent, r: win.fatigueRecent, p: win.fatiguePrior };
  const params = [ids];
  const cols = [];
  Object.entries(windows).forEach(([key, w]) => {
    params.push(w.since, w.until);
    const a = params.length - 1;
    const b = params.length;
    METRIC_KEYS.forEach((k) => {
      cols.push(`COALESCE(SUM(d.${k}) FILTER (WHERE d.insight_date BETWEEN $${a} AND $${b}), 0) AS ${key}_${k}`);
    });
  });
  const [insRes, launchRes, coverageRes, wndrrRes, famRes] = await Promise.all([
    ids.length
      ? db.query(
        `SELECT d.meta_ad_id,
                to_char(MIN(d.insight_date) FILTER (WHERE d.spend > 0), 'YYYY-MM-DD') AS first_spend,
                to_char(MAX(d.insight_date) FILTER (WHERE d.spend > 0), 'YYYY-MM-DD') AS last_spend,
                ${cols.join(',\n                ')}
           FROM meta_ad_insights_daily d WHERE d.meta_ad_id = ANY($1) GROUP BY d.meta_ad_id`,
        params
      )
      : Promise.resolve({ rows: [] }),
    ids.length
      ? db.query(
        `SELECT meta_ad_id, to_char(MIN(insight_date) FILTER (WHERE cs >= $2), 'YYYY-MM-DD') AS launch
           FROM (SELECT meta_ad_id, insight_date,
                        SUM(spend) OVER (PARTITION BY meta_ad_id ORDER BY insight_date) AS cs
                   FROM meta_ad_insights_daily WHERE meta_ad_id = ANY($1)) t
          GROUP BY meta_ad_id`,
        [ids, cfg.LAUNCH.meaningful_spend]
      )
      : Promise.resolve({ rows: [] }),
    db.query(`SELECT to_char(MIN(insight_date), 'YYYY-MM-DD') AS first_day, to_char(MAX(insight_date), 'YYYY-MM-DD') AS last_day FROM meta_ad_insights_daily`),
    db.query(
      `SELECT s.style_code, MAX(ca.created_at) AS created_at, MAX(ca.final_approved_at) AS approved_at,
              (SELECT MAX(sh.changed_at) FROM status_history sh JOIN creative_assets c2 ON c2.id = sh.creative_asset_id
                WHERE c2.style_id = s.id AND sh.to_status = 'uploaded_live') AS live_at
         FROM styles s JOIN creative_assets ca ON ca.style_id = s.id GROUP BY s.id, s.style_code`
    ),
    db.query('SELECT style_code, name FROM styles ORDER BY style_code ASC'),
  ]);

  const ins = new Map(insRes.rows.map((r) => [r.meta_ad_id, r]));
  const launchByAd = new Map(launchRes.rows.map((r) => [r.meta_ad_id, r.launch]));
  const coverageStart = coverageRes.rows[0].first_day;
  const edge = coverageStart ? addDays(coverageStart, cfg.LAUNCH.coverage_edge_days) : null;

  const ads = adsRes.rows.map((r) => {
    const i = ins.get(r.meta_ad_id);
    const w = {};
    Object.keys(windows).forEach((k) => {
      w[k] = zero();
      if (i) METRIC_KEYS.forEach((m) => { w[k][m] = num(i[`${k}_${m}`]); });
    });
    const created = r.created_time ? ymdInZone(new Date(r.created_time), REPORTING_TIMEZONE) : null;
    const launch = launchDateOf(launchByAd.get(r.meta_ad_id) || null, created, edge);
    const conceptLabel = r.concept_label || null;
    return {
      id: r.meta_ad_id,
      name: r.ad_name,
      effective_status: r.effective_status,
      creative_key: r.meta_creative_id || r.meta_ad_id,
      status: r.match_status,
      products: r.products,
      concept_key: conceptLabel ? (r.concept_type_id ? `ct:${r.concept_type_id}` : `legacy:${norm(conceptLabel)}`) : null,
      concept_label: conceptLabel,
      concept_legacy: !!conceptLabel && !r.concept_type_id,
      creator_key: r.creator_name ? norm(r.creator_name) : null,
      creator_label: r.creator_name || null,
      media_key: r.media_type || null,
      first_spend: i ? i.first_spend : null,
      last_spend: i ? i.last_spend : null,
      created,
      launch: launch.date,
      launch_basis: launch.basis,
      w,
    };
  });

  const families = new Map();
  famRes.rows.forEach((r) => {
    const code = deriveProductCode(r.style_code);
    if (!families.has(code)) families.set(code, r.name);
  });
  const wndrr = new Map(); // product_code -> {live, approved, created} (ymd)
  const toYmd = (v) => (v ? ymdInZone(new Date(v), REPORTING_TIMEZONE) : null);
  const later = (a, b) => (a && b ? (a > b ? a : b) : (a || b));
  wndrrRes.rows.forEach((r) => {
    const code = deriveProductCode(r.style_code);
    const cur = wndrr.get(code) || { live: null, approved: null, created: null };
    wndrr.set(code, { live: later(cur.live, toYmd(r.live_at)), approved: later(cur.approved, toYmd(r.approved_at)), created: later(cur.created, toYmd(r.created_at)) });
  });
  return { win, ads, families, wndrr, coverage: { first_day: coverageStart, last_day: coverageRes.rows[0].last_day } };
}

// Launch date of one ad (see config LAUNCH for the reasoning).
function launchDateOf(meaningfulSpendDay, createdYmd, coverageEdgeYmd) {
  if (!meaningfulSpendDay) return { date: null, basis: 'no meaningful spend' };
  if (coverageEdgeYmd && meaningfulSpendDay <= coverageEdgeYmd && createdYmd && createdYmd < meaningfulSpendDay) {
    return { date: createdYmd, basis: 'created date (already spending when stored data begins)' };
  }
  return { date: meaningfulSpendDay, basis: 'first day with meaningful spend' };
}

// ── demand (sales) ──────────────────────────────────────────────────────
// Real provider: ApparelMagic order history + Report Pipeline tiers, the
// exact sources Core / High Stock use. Never forces a fresh AM crawl (the
// same cache gate High Stock uses). Returns { available, reason, byProduct }.
const TIER_ORDER = ['platinum', 'rocket', 'surfer', 'dog', 'egg'];
const TIER_LABEL = { platinum: 'Platinum', rocket: 'Rocket', surfer: 'Surfer', dog: 'Dog', egg: 'Egg' };
async function loadDemand() {
  const apparelmagic = require('./apparelmagic');
  const reportPipeline = require('./reportPipeline');
  if (!apparelmagic.configured()) return { available: false, reason: 'ApparelMagic is not configured', byProduct: new Map() };
  if (!apparelmagic.getAmCacheStatus().sales.hasData) return { available: false, reason: 'Sales data has not loaded yet', byProduct: new Map() };
  const [sales, tiers] = await Promise.all([
    apparelmagic.getSalesByStyle(),
    reportPipeline.configured() ? reportPipeline.getStyleTiers().catch(() => null) : Promise.resolve(null),
  ]);
  const byProduct = new Map();
  for (const [styleCode, s] of sales.entries()) {
    const code = deriveProductCode(styleCode);
    const cur = byProduct.get(code) || { units_7d: 0, units_30d: 0, units_365d: 0, tier: null };
    cur.units_7d += num(s.qty7); cur.units_30d += num(s.qty30); cur.units_365d += num(s.qty365);
    byProduct.set(code, cur);
  }
  if (tiers) {
    for (const [styleCode, t] of tiers.entries()) {
      const code = deriveProductCode(styleCode);
      const cur = byProduct.get(code) || { units_7d: 0, units_30d: 0, units_365d: 0, tier: null };
      if (t && t.tier && (cur.tier === null || TIER_ORDER.indexOf(t.tier) < TIER_ORDER.indexOf(cur.tier))) cur.tier = t.tier;
      byProduct.set(code, cur);
    }
  }
  return { available: true, reason: null, byProduct, tiers_available: !!tiers };
}

// Raw demand -> strong / weak / neutral per product (cfg.SELLER).
function classifySellers(demand) {
  const out = new Map();
  if (!demand || !demand.available) return out;
  const S = cfg.SELLER;
  const sorted = [...demand.byProduct.values()].map((d) => d.units_30d).filter((u) => u > 0).sort((a, b) => a - b);
  const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  const strongCut = at(S.fallback_strong_percentile);
  const weakCut = at(S.fallback_weak_percentile);
  const { salesTrendInfo } = require('../routes/highStockProducts');
  for (const [code, d] of demand.byProduct.entries()) {
    const vel30 = (d.units_30d / 30) * 7;
    const vel365 = (d.units_365d / 365) * 7;
    const trend = salesTrendInfo(vel30, vel365);
    let cls = 'neutral';
    let basis = d.tier ? `${TIER_LABEL[d.tier] || d.tier} sales tier` : 'relative 30-day units';
    if (d.tier) {
      if (S.strong_tiers.includes(d.tier)) cls = 'strong';
      else if (S.weak_tiers.includes(d.tier) && d.units_365d >= S.weak_min_units_365d) cls = 'weak';
    } else {
      if (strongCut !== null && d.units_30d >= S.fallback_min_units_30d_strong && d.units_30d >= strongCut) cls = 'strong';
      else if (weakCut !== null && d.units_365d >= S.weak_min_units_365d && d.units_30d <= weakCut) cls = 'weak';
    }
    out.set(code, {
      units_7d: round(d.units_7d, 1), units_30d: round(d.units_30d, 1), units_365d: round(d.units_365d, 1),
      vel30: round(vel30, 1), vel365: round(vel365, 1),
      trend: { pct: trend.pct, reliable: trend.reliable, display: trend.display, direction: !trend.reliable ? null : trend.pct >= 10 ? 'up' : trend.pct <= -10 ? 'down' : 'flat' },
      tier: d.tier, tier_label: d.tier ? TIER_LABEL[d.tier] || d.tier : null, seller_class: cls, basis,
    });
  }
  return out;
}

// ── per-product signals ─────────────────────────────────────────────────
function mixOf(entries, keyOf, labelOf, windowKey = 'e') {
  const map = new Map();
  let total = 0;
  let known = 0;
  entries.forEach(({ ad, f }) => {
    const spend = ad.w[windowKey].spend * f;
    total += spend;
    const k = keyOf(ad);
    if (!k) return;
    known += spend;
    const cur = map.get(k) || { key: k, label: labelOf(ad), spend: 0, creatives: new Set() };
    cur.spend += spend;
    if (ad.w[windowKey].spend > 0) cur.creatives.add(ad.creative_key);
    map.set(k, cur);
  });
  const rows = [...map.values()].map((r) => ({ key: r.key, label: r.label, spend: round(r.spend), share: known > 0 ? round(r.spend / known, 4) : null, creatives: r.creatives.size }))
    .sort((a, b) => b.spend - a.spend || String(a.key).localeCompare(String(b.key)));
  return { rows, total_spend: total, known_spend: known, field_coverage: total > 0 ? round(known / total, 4) : null };
}

function buildProductSignals(snapshot, sellers) {
  const { win, ads, families, wndrr } = snapshot;
  const byProduct = new Map();
  ads.forEach((ad) => {
    const n = ad.products.length;
    ad.products.forEach((p) => {
      if (!byProduct.has(p.code)) byProduct.set(p.code, { code: p.code, name: families.get(p.code) || p.name || p.code, entries: [] });
      byProduct.get(p.code).entries.push({ ad, f: 1 / n, shared: n - 1 });
    });
  });
  // products that have sales/creative history but no classified Meta ads still get a signal row
  sellers.forEach((_, code) => { if (!byProduct.has(code) && families.has(code)) byProduct.set(code, { code, name: families.get(code), entries: [] }); });
  wndrr.forEach((_, code) => { if (!byProduct.has(code) && families.has(code)) byProduct.set(code, { code, name: families.get(code), entries: [] }); });

  const out = new Map();
  for (const [code, p] of byProduct.entries()) {
    const sum = (key) => p.entries.reduce((acc, { ad, f }) => addInto(acc, ad.w[key], f), zero());
    const e = sum('e');
    const m = sum('m');
    const active90 = p.entries.filter(({ ad }) => ad.w.e.spend > 0);
    const active30 = p.entries.filter(({ ad }) => ad.w.m.spend > 0);
    const creatives90 = new Set(active90.map(({ ad }) => ad.creative_key));
    const creatives30 = new Set(active30.map(({ ad }) => ad.creative_key));
    const launches = p.entries.map(({ ad }) => ad.launch).filter(Boolean).sort();
    const newestMeta = launches.length ? launches[launches.length - 1] : null;
    const w = wndrr.get(code) || { live: null, approved: null, created: null };
    const candidates = [
      newestMeta ? { date: newestMeta, source: 'Meta launch' } : null,
      w.live ? { date: w.live, source: 'WNDRR creative went live' } : null,
    ].filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1));
    const newest = candidates[0] || null;
    const daysSinceNewest = newest ? Math.max(0, daysBetween(newest.date, win.today)) : null;
    const oldSpend = p.entries.reduce((acc, { ad, f }) => acc + (ad.launch && daysBetween(ad.launch, win.today) >= cfg.FRESHNESS.stale_lt ? ad.w.m.spend * f : 0), 0);
    const sales = sellers.get(code) || null;
    out.set(code, {
      code,
      name: p.name,
      entries: p.entries,
      sales,
      e, m,
      active_ads_30d: active30.length,
      creatives_90d: creatives90.size,
      creatives_30d: creatives30.size,
      newest_meta_launch: newestMeta,
      days_since_meta_launch: newestMeta ? Math.max(0, daysBetween(newestMeta, win.today)) : null,
      wndrr_live: w.live, wndrr_approved: w.approved, wndrr_created: w.created,
      newest_creative_date: newest ? newest.date : null,
      newest_creative_source: newest ? newest.source : null,
      days_since_newest_creative: daysSinceNewest,
      freshness: freshnessBand(daysSinceNewest),
      old_creative_spend_30d: round(oldSpend),
      old_creative_share_30d: m.spend > 0 ? round(oldSpend / m.spend, 4) : null,
      mix: {
        concept: mixOf(active90, (ad) => ad.concept_key, (ad) => ad.concept_label),
        creator: mixOf(active90, (ad) => ad.creator_key, (ad) => ad.creator_label),
        media: mixOf(active90, (ad) => ad.media_key, (ad) => MEDIA_LABEL[ad.media_key] || ad.media_key),
      },
      relevant: (sales && sales.units_30d >= cfg.RELEVANCE.min_units_30d) || m.spend >= cfg.RELEVANCE.min_recent_meta_spend,
    });
  }
  return out;
}

// ── concept analysis (account level, evidence window) ───────────────────
function analyseConcepts(snapshot) {
  const { ads, families } = snapshot;
  const C = cfg.CONCEPT;
  const total = zero();
  ads.forEach((ad) => addInto(total, ad.w.e));
  const benchmarkCpa = ratio(total.spend, total.purchases);
  const concepts = new Map();
  ads.forEach((ad) => {
    if (!ad.concept_key || !(ad.w.e.spend > 0)) return;
    const cur = concepts.get(ad.concept_key) || { key: ad.concept_key, label: ad.concept_label, legacy: ad.concept_legacy, m: zero(), creatives: new Set(), products: new Map(), media: new Map() };
    addInto(cur.m, ad.w.e);
    cur.creatives.add(ad.creative_key);
    const n = ad.products.length;
    ad.products.forEach((p) => {
      const pc = cur.products.get(p.code) || { code: p.code, spend: 0, purchases: 0 };
      pc.spend += ad.w.e.spend / n; pc.purchases += ad.w.e.purchases / n;
      cur.products.set(p.code, pc);
    });
    if (ad.media_key) cur.media.set(ad.media_key, (cur.media.get(ad.media_key) || 0) + ad.w.e.spend);
    concepts.set(ad.concept_key, cur);
  });
  const out = [];
  concepts.forEach((c) => {
    const cpa = ratio(c.m.spend, c.m.purchases);
    const usedOn = [...c.products.values()].filter((p) => p.spend >= C.min_product_spend);
    const clearsSample = c.m.spend >= C.min_spend && c.m.purchases >= C.min_purchases && c.creatives.size >= C.min_creatives;
    const cpaOk = cpa !== null && benchmarkCpa !== null && cpa <= benchmarkCpa * C.max_cpa_ratio;
    let status = 'insufficient';
    if (clearsSample && cpaOk) status = 'proven';
    else if (c.m.spend >= C.min_spend && ((cpa !== null && benchmarkCpa !== null && cpa > benchmarkCpa * C.weak_cpa_ratio) || c.m.purchases === 0)) status = 'weak';
    const topMedia = [...c.media.entries()].sort((a, b) => b[1] - a[1])[0];
    out.push({
      key: c.key, label: c.label, legacy: c.legacy, status,
      cross_product_winner: status === 'proven' && usedOn.length >= C.min_products_cross_product,
      creatives: c.creatives.size,
      spend: round(c.m.spend), purchases: c.m.purchases, cpa: round(cpa), cpa_vs_account: cpa !== null && benchmarkCpa ? round(cpa / benchmarkCpa, 3) : null,
      outbound_ctr: round(c.m.impressions > 0 ? (c.m.outbound_clicks / c.m.impressions) * 100 : null, 3),
      products: usedOn.map((p) => ({ code: p.code, name: families.get(p.code) || p.code, spend: round(p.spend), purchases: round(p.purchases, 2) })).sort((a, b) => b.spend - a.spend),
      products_used_on: usedOn.length,
      media: topMedia ? topMedia[0] : null,
      thresholds: { min_spend: C.min_spend, min_purchases: C.min_purchases, min_creatives: C.min_creatives, max_cpa_ratio: C.max_cpa_ratio },
    });
  });
  out.sort((a, b) => (a.status === 'proven' ? 0 : 1) - (b.status === 'proven' ? 0 : 1) || b.spend - a.spend || String(a.key).localeCompare(String(b.key)));
  return { benchmark: { cpa: round(benchmarkCpa), spend: round(total.spend), purchases: total.purchases }, concepts: out };
}

// ── recommendation builders ─────────────────────────────────────────────
function ctaMetrics(entriesSum) {
  const d = deriveMetrics({ ...entriesSum, purchase_value: 0 });
  return { spend: d.spend, purchases: round(d.purchases, 2), cpa: d.cpa, cost_per_atc: d.cost_per_atc, outbound_ctr: d.outbound_ctr, add_to_cart: round(d.add_to_cart, 2) };
}

function evidenceFor(ps, snapshot, extra = {}) {
  const { win } = snapshot;
  const adRows = ps.entries
    .filter(({ ad }) => ad.w.e.spend > 0)
    .sort((a, b) => b.ad.w.e.spend * b.f - a.ad.w.e.spend * a.f)
    .slice(0, cfg.LIMITS.evidence_ads)
    .map(({ ad, f, shared }) => ({
      meta_ad_id: ad.id, ad_name: ad.name, match: ad.status, launch: ad.launch, launch_basis: ad.launch_basis,
      spend: round(ad.w.e.spend * f), purchases: round(ad.w.e.purchases * f, 2),
      concept: ad.concept_label, creator: ad.creator_label, media: ad.media_key ? MEDIA_LABEL[ad.media_key] || ad.media_key : null,
      shared_with_products: shared,
    }));
  return {
    window: { since: win.evidence.since, until: win.evidence.until, recent_since: win.recent.since },
    sales: ps.sales ? { available: true, ...ps.sales } : { available: false },
    creative: {
      newest_creative_date: ps.newest_creative_date, newest_creative_source: ps.newest_creative_source,
      days_since_newest_creative: ps.days_since_newest_creative, freshness: ps.freshness,
      newest_meta_launch: ps.newest_meta_launch, days_since_meta_launch: ps.days_since_meta_launch,
      wndrr_live: ps.wndrr_live, wndrr_approved: ps.wndrr_approved,
      creatives_90d: ps.creatives_90d, creatives_30d: ps.creatives_30d,
    },
    meta: {
      last_90d: ctaMetrics(ps.e), last_30d: ctaMetrics(ps.m), active_ads_30d: ps.active_ads_30d,
      old_creative_spend_30d: ps.old_creative_spend_30d, old_creative_share_30d: ps.old_creative_share_30d,
    },
    mix: {
      concept: ps.mix.concept.rows.slice(0, 5), creator: ps.mix.creator.rows.slice(0, 5), media: ps.mix.media.rows.slice(0, 5),
      field_coverage: { concept: ps.mix.concept.field_coverage, creator: ps.mix.creator.field_coverage, media: ps.mix.media.field_coverage },
    },
    ads: adRows,
    attribution: 'Included: confirmed and auto-matched ads only. Ads covering several products have their spend and purchases split equally between those products (creative presence counts for each).',
    ...extra,
  };
}

function salesChips(ps) {
  const chips = [];
  if (ps.sales && ps.sales.trend && ps.sales.trend.direction === 'up') chips.push({ kind: 'sales', tone: 'good', text: 'Sales ↑' });
  else if (ps.sales && ps.sales.trend && ps.sales.trend.direction === 'down') chips.push({ kind: 'sales', tone: 'warn', text: 'Sales ↓' });
  else if (ps.sales && ps.sales.seller_class === 'strong') chips.push({ kind: 'sales', tone: 'good', text: ps.sales.tier_label ? `${ps.sales.tier_label} seller` : 'Strong seller' });
  else if (ps.sales && ps.sales.seller_class === 'weak') chips.push({ kind: 'sales', tone: 'warn', text: 'Weak seller' });
  return chips;
}
function ageChip(ps) {
  if (ps.days_since_newest_creative === null) return { kind: 'age', tone: 'bad', text: 'No creative on record' };
  return { kind: 'age', tone: ps.freshness.band === 'very_stale' ? 'bad' : 'warn', text: `${plural(ps.days_since_newest_creative, 'day')} stale` };
}
const spendChip = (ps) => ({ kind: 'spend', tone: 'neutral', text: `${money(ps.m.spend)} Meta spend (30d)` });

function finish(opp, ps) {
  const strength = Math.max(0, Math.min(100, Math.round(opp.rank.components.reduce((s, c) => s + c.points, 0))));
  opp.rank.strength = strength;
  opp.rank.score = cfg.PRIORITY_BASE[opp.priority] + strength;
  opp.product_signals = { units_30d: ps.sales ? ps.sales.units_30d : null };
  return opp;
}

function baseOpp(type, ps, priority, severity) {
  return {
    key: `${type}:${ps.code}`, type, priority, severity,
    products: [{ product_code: ps.code, product_name: ps.name }],
    recommended_concept: null, recommended_media: null,
    rank: { components: [] },
  };
}

// The concept the product itself already proved (own "worked before" hint).
function ownBestConcept(ps) {
  const byConcept = new Map();
  ps.entries.forEach(({ ad, f }) => {
    if (!ad.concept_key || !(ad.w.e.spend > 0)) return;
    const cur = byConcept.get(ad.concept_key) || { key: ad.concept_key, label: ad.concept_label, spend: 0, purchases: 0 };
    cur.spend += ad.w.e.spend * f; cur.purchases += ad.w.e.purchases * f;
    byConcept.set(ad.concept_key, cur);
  });
  const best = [...byConcept.values()].filter((c) => c.purchases >= cfg.CONCEPT.own_concept_min_purchases && c.spend > 0)
    .sort((a, b) => a.spend / a.purchases - b.spend / b.purchases || b.purchases - a.purchases)[0];
  return best ? { key: best.key, label: best.label, cpa: round(best.spend / best.purchases), purchases: round(best.purchases, 1) } : null;
}

function recFreshen(ps, snapshot) {
  const d = ps.days_since_newest_creative;
  if (!ps.sales || ps.sales.seller_class !== 'strong') return null;
  if (ps.freshness.band === 'fresh' || ps.freshness.band === 'aging') return null;
  const veryStale = ps.freshness.band === 'very_stale';
  const opp = baseOpp('freshen_strong_seller', ps, veryStale ? 'Critical' : 'High', d === null ? 99 : Math.floor(d / 60));
  const own = ownBestConcept(ps);
  opp.title = `Shoot fresh ${ps.name} creative`;
  opp.explanation = d === null
    ? `${ps.name} is selling strongly (${ps.sales.basis}) but has no creative on record.`
    : `${ps.name} is selling strongly (${ps.sales.basis}${ps.sales.trend.direction === 'up' ? ', sales trending up' : ''}) but has had no new creative for ${plural(d, 'day')}.`;
  if (own) { opp.recommended_concept = { key: own.key, label: own.label }; opp.explanation += ` ${own.label} has worked on it before (CPA ${money(own.cpa)}).`; }
  opp.chips = [...salesChips(ps), ageChip(ps), spendChip(ps), ...(own ? [{ kind: 'concept', tone: 'neutral', text: own.label }] : [])];
  opp.evidence = evidenceFor(ps, snapshot, { reason: { rule: 'Strong seller with a Stale / Very stale newest creative', strong_seller_basis: ps.sales.basis, freshness_thresholds: cfg.FRESHNESS, own_best_concept: own } });
  opp.rank.components = [
    { name: 'days since newest creative (1 pt per 2 days, max 60)', points: d === null ? 60 : Math.min(60, d / 2) },
    { name: 'recent weekly sales velocity (max 25)', points: Math.min(25, ps.sales.vel30) },
    { name: 'sales trending up', points: ps.sales.trend.direction === 'up' ? 15 : 0 },
  ];
  return finish(opp, ps);
}

function recRefresh(ps, snapshot) {
  const d = ps.days_since_newest_creative;
  if (!ps.sales || ps.sales.seller_class !== 'weak') return null;
  const W = cfg.WEAK_SELLER;
  const veryStale = ps.freshness.band === 'very_stale';
  const underTested = ps.freshness.band === 'stale' && ps.e.spend < W.fair_test_spend;
  if (!veryStale && !underTested) return null; // weak with recent / adequately tested creative: not this recommendation
  const high = d === null || d >= W.high_after_days;
  const opp = baseOpp('refresh_before_deprioritising', ps, high ? 'High' : 'Medium', d === null ? 99 : Math.floor(d / 60));
  opp.title = 'Refresh creative before deprioritising';
  opp.explanation = underTested
    ? `Performance is weak, but ${ps.name}'s newest creative is ${plural(d, 'day')} old and it had only ${money(ps.e.spend)} of Meta spend in the last ${cfg.WINDOWS.evidence_days} days — too little to judge it fairly.`
    : d === null
      ? `Performance is weak, but ${ps.name} has no creative on record, so it has not had a fair creative test.`
      : `Performance is weak, but ${ps.name} has not had a fresh creative test in ${ageText(d)}.`;
  opp.chips = [...salesChips(ps), ageChip(ps), spendChip(ps)];
  opp.evidence = evidenceFor(ps, snapshot, { reason: { rule: underTested ? 'Weak seller, Stale creative, under-tested' : 'Weak seller with Very stale / no creative', weak_seller_basis: ps.sales.basis, fair_test_spend: W.fair_test_spend } });
  opp.rank.components = [
    { name: 'days since newest creative (1 pt per 4 days, max 50)', points: d === null ? 50 : Math.min(50, d / 4) },
    { name: 'sales history (units in last 365d, max 30)', points: Math.min(30, ps.sales.units_365d / 10) },
    { name: 'under-tested (little Meta spend)', points: underTested ? 20 : 0 },
  ];
  return finish(opp, ps);
}

function recCoverage(ps, snapshot) {
  if (!ps.relevant) return null;
  if (ps.creatives_90d >= cfg.COVERAGE.min_creatives_90d) return null;
  const strong = ps.sales && ps.sales.seller_class === 'strong';
  const opp = baseOpp('increase_creative_coverage', ps, strong ? 'High' : 'Medium', cfg.COVERAGE.min_creatives_90d - ps.creatives_90d);
  opp.title = 'Increase creative coverage';
  opp.explanation = ps.creatives_90d === 0
    ? `${ps.name} has had no creative with Meta spend in the last ${cfg.WINDOWS.evidence_days} days.`
    : `${ps.name} has only ${plural(ps.creatives_90d, 'creative execution')} with Meta spend in the last ${cfg.WINDOWS.evidence_days} days (target: ${cfg.COVERAGE.min_creatives_90d}+).`;
  const own = ownBestConcept(ps);
  if (own) opp.recommended_concept = { key: own.key, label: own.label };
  opp.chips = [...salesChips(ps), { kind: 'coverage', tone: 'warn', text: `${plural(ps.creatives_90d, 'creative')} in 90d` }, spendChip(ps)];
  opp.evidence = evidenceFor(ps, snapshot, { reason: { rule: 'Fewer than the minimum creatives with spend in the evidence window', min_creatives_90d: cfg.COVERAGE.min_creatives_90d } });
  opp.rank.components = [
    { name: 'missing creatives (20 pts each)', points: (cfg.COVERAGE.min_creatives_90d - ps.creatives_90d) * 20 },
    { name: 'recent weekly sales velocity (max 30)', points: ps.sales ? Math.min(30, ps.sales.vel30) : 0 },
    { name: 'recent Meta spend (1 pt per $50, max 20)', points: Math.min(20, ps.m.spend / 50) },
  ];
  return finish(opp, ps);
}

function recFatigue(ps, snapshot) {
  const F = cfg.FATIGUE;
  const { win } = snapshot;
  const r = zero();
  const p = zero();
  let n = 0;
  ps.entries.forEach(({ ad, f }) => {
    const runDays = ad.first_spend ? daysBetween(ad.first_spend, win.until) : 0;
    if (runDays < F.min_run_days || !(ad.w.r.spend > 0) || !(ad.w.p.spend > 0)) return;
    addInto(r, ad.w.r, f); addInto(p, ad.w.p, f); n += 1;
  });
  if (!n || r.impressions < F.min_impressions || p.impressions < F.min_impressions) return null;
  const ctrR = ratio(r.outbound_clicks, r.impressions);
  const ctrP = ratio(p.outbound_clicks, p.impressions);
  if (ctrR === null || ctrP === null || ctrP === 0) return null;
  const ctrDrop = (1 - ctrR / ctrP) * 100;
  if (ctrDrop < F.ctr_drop_pct) return null;
  // CPA must also have deteriorated, from enough purchases on both sides
  if (r.purchases < F.min_purchases || p.purchases < F.min_purchases) return null;
  const cpaR = ratio(r.spend, r.purchases);
  const cpaP = ratio(p.spend, p.purchases);
  const cpaRise = (cpaR / cpaP - 1) * 100;
  if (cpaRise < F.cpa_rise_pct) return null;
  const strong = ps.sales && ps.sales.seller_class === 'strong';
  const opp = baseOpp('possible_fatigue', ps, strong ? 'High' : 'Medium', Math.floor(ctrDrop / F.ctr_drop_pct));
  opp.title = 'Possible fatigue';
  opp.explanation = `On ${plural(n, 'ad')} running ${F.min_run_days}+ days, ${ps.name}'s outbound CTR fell ${Math.round(ctrDrop)}% and CPA rose ${Math.round(cpaRise)}% over the last ${cfg.WINDOWS.fatigue_days} days vs the ${cfg.WINDOWS.fatigue_days} before. Reach and frequency are not available, so this is a signal, not a diagnosis.`;
  opp.chips = [...salesChips(ps), { kind: 'fatigue', tone: 'warn', text: `CTR −${Math.round(ctrDrop)}%` }, { kind: 'fatigue', tone: 'warn', text: `CPA +${Math.round(cpaRise)}%` }];
  opp.evidence = evidenceFor(ps, snapshot, {
    reason: { rule: 'Same ads, last vs prior window: CTR down and CPA up with minimum volume', thresholds: F, note: 'Never uses reach or frequency' },
    fatigue: {
      ads_compared: n,
      recent: { since: win.fatigueRecent.since, until: win.fatigueRecent.until, ...ctaMetrics(r) },
      prior: { since: win.fatiguePrior.since, until: win.fatiguePrior.until, ...ctaMetrics(p) },
      ctr_change_pct: round(-ctrDrop, 1), cpa_change_pct: round(cpaRise, 1),
    },
  });
  opp.rank.components = [
    { name: 'CTR drop (1 pt per 1%, max 50)', points: Math.min(50, ctrDrop) },
    { name: 'CPA rise (1 pt per 1%, max 30)', points: Math.min(30, cpaRise) },
    { name: 'recent Meta spend (1 pt per $100, max 20)', points: Math.min(20, ps.m.spend / 100) },
  ];
  return finish(opp, ps);
}

const DIVERSIFY = {
  concept: { type: 'diversify_concept', title: 'Diversify concepts', noun: 'concept', fix: 'Test a different concept' },
  creator: { type: 'diversify_creator', title: 'Diversify creators', noun: 'creator', fix: 'Use a different creator' },
  media: { type: 'diversify_media', title: 'Diversify media types', noun: 'media type', fix: 'Add another media type' },
};
function recDiversify(ps, snapshot, field) {
  const D = cfg.CONCENTRATION;
  const meta = DIVERSIFY[field];
  if (ps.creatives_90d < D.min_creatives || ps.e.spend < D.min_product_spend) return null;
  const mix = ps.mix[field];
  if (mix.field_coverage === null || mix.field_coverage < D.min_field_coverage) return null; // not enough ads carry this field to claim a concentration
  const top = mix.rows[0];
  if (!top || top.share === null || top.share < D.share) return null;
  const strong = ps.sales && ps.sales.seller_class === 'strong';
  const opp = baseOpp(meta.type, ps, strong ? 'High' : 'Medium', top.share >= 0.999 ? 2 : 1);
  opp.title = meta.title;
  opp.explanation = field === 'media' && top.share >= 0.999
    ? `Only ${top.label} has been tested for ${ps.name} (${plural(ps.creatives_90d, 'creative')}, ${money(ps.e.spend)} in ${cfg.WINDOWS.evidence_days} days).`
    : `${pct(top.share)} of ${ps.name}'s last-${cfg.WINDOWS.evidence_days}-day spend is on one ${meta.noun} (${top.label}). ${meta.fix} to reduce reliance on it.`;
  opp.chips = [...salesChips(ps), { kind: 'mix', tone: 'warn', text: `${pct(top.share)} on ${top.label}` }, { kind: 'coverage', tone: 'neutral', text: `${plural(ps.creatives_90d, 'creative')} in 90d` }];
  opp.evidence = evidenceFor(ps, snapshot, { reason: { rule: `Top ${meta.noun} carries >= ${pct(D.share)} of evidence-window spend`, thresholds: D, concentrated_on: { key: top.key, label: top.label, share: top.share } } });
  opp.rank.components = [
    { name: 'concentration above threshold (1 pt per 1%, max 10)', points: Math.min(10, (top.share - D.share) * 100) },
    { name: 'spend at stake (1 pt per $100, max 50)', points: Math.min(50, ps.e.spend / 100) },
    { name: 'recent weekly sales velocity (max 40)', points: ps.sales ? Math.min(40, ps.sales.vel30) : 0 },
  ];
  return finish(opp, ps);
}

function recTestConcepts(signals, conceptAnalysis, snapshot) {
  const C = cfg.CONCEPT;
  const L = cfg.LIMITS;
  const cands = [];
  const proven = conceptAnalysis.concepts.filter((c) => c.status === 'proven' && c.products_used_on >= C.test_min_products);
  signals.forEach((ps) => {
    if (!ps.relevant) return;
    const used = new Set(ps.entries.map(({ ad }) => ad.concept_key).filter(Boolean)); // ANY use, any date -> pairing exists
    proven.forEach((c) => {
      if (used.has(c.key)) return;
      const strong = ps.sales && ps.sales.seller_class === 'strong';
      const opp = baseOpp('test_proven_concept', ps, strong ? 'High' : 'Medium', Math.min(5, c.products_used_on));
      opp.key = `test_proven_concept:${ps.code}:${c.key}`;
      opp.title = `Test ${c.label} for ${ps.name}`;
      opp.explanation = `${c.label} is performing well across ${plural(c.products_used_on, 'product')} (CPA ${money(c.cpa)} vs account ${money(conceptAnalysis.benchmark.cpa)}). ${ps.name} has not tested this concept.`;
      opp.recommended_concept = { key: c.key, label: c.label };
      opp.recommended_media = c.media ? { key: c.media, label: MEDIA_LABEL[c.media] || c.media } : null;
      opp.chips = [...salesChips(ps), { kind: 'concept', tone: 'good', text: c.label }, ...(opp.recommended_media ? [{ kind: 'media', tone: 'neutral', text: opp.recommended_media.label }] : []), { kind: 'proof', tone: 'good', text: `${plural(c.products_used_on, 'product')} · ${c.purchases} purchases` }];
      opp.evidence = evidenceFor(ps, snapshot, {
        reason: { rule: 'Concept clears the minimum-evidence rules and this product has never run it', concept_thresholds: C },
        concept: { ...c, account_cpa: conceptAnalysis.benchmark.cpa },
      });
      const advantage = c.cpa_vs_account !== null ? (1 - c.cpa_vs_account) * 100 : 0;
      opp.rank.components = [
        { name: 'products the concept has worked on (10 pts each, max 40)', points: Math.min(40, c.products_used_on * 10) },
        { name: 'CPA advantage vs account (1 pt per 1%, max 25)', points: Math.max(0, Math.min(25, advantage)) },
        { name: 'recent weekly sales velocity (max 25)', points: ps.sales ? Math.min(25, ps.sales.vel30) : 0 },
        { name: 'sales trending up', points: ps.sales && ps.sales.trend.direction === 'up' ? 10 : 0 },
      ];
      cands.push(finish(opp, ps));
    });
  });
  cands.sort((a, b) => b.rank.score - a.rank.score || (b.product_signals.units_30d || 0) - (a.product_signals.units_30d || 0) || a.key.localeCompare(b.key));
  const perProduct = new Map();
  const perConcept = new Map();
  const out = [];
  cands.forEach((o) => {
    const pk = o.products[0].product_code;
    const ck = o.recommended_concept.key;
    if ((perProduct.get(pk) || 0) >= L.max_test_concept_per_product) return;
    if ((perConcept.get(ck) || 0) >= L.max_test_concept_per_concept) return;
    if (out.length >= L.max_test_concept_total) return;
    perProduct.set(pk, (perProduct.get(pk) || 0) + 1);
    perConcept.set(ck, (perConcept.get(ck) || 0) + 1);
    out.push(o);
  });
  return out;
}

// ── orchestration ───────────────────────────────────────────────────────
function generateOpportunities(snapshot, demand) {
  const sellers = classifySellers(demand);
  const signals = buildProductSignals(snapshot, sellers);
  const conceptAnalysis = analyseConcepts(snapshot);
  const opps = [];
  signals.forEach((ps) => {
    // one primary staleness/coverage recommendation per product (cfg.PRIMARY_ORDER)
    const primary = recFreshen(ps, snapshot) || recRefresh(ps, snapshot) || recCoverage(ps, snapshot);
    if (primary) opps.push(primary);
    const fat = recFatigue(ps, snapshot);
    if (fat) opps.push(fat);
    if (!primary || primary.type !== 'increase_creative_coverage') {
      ['concept', 'creator', 'media'].forEach((f) => { const o = recDiversify(ps, snapshot, f); if (o) opps.push(o); });
    }
  });
  opps.push(...recTestConcepts(signals, conceptAnalysis, snapshot));
  const generatedAt = new Date().toISOString();
  opps.forEach((o) => { o.generated_at = generatedAt; });
  opps.sort((a, b) => b.rank.score - a.rank.score || a.key.localeCompare(b.key));
  return { opportunities: opps, signals, concepts: conceptAnalysis, sellers };
}

// Applies human decisions to the freshly computed list.
//   dismissed  hidden until priority OR severity increases vs the dismissal
//   acted_on   hidden for cfg.STATE.acted_on_review_days, then returns
function applyStates(opps, stateRows, now = new Date()) {
  const states = new Map(stateRows.map((r) => [r.opportunity_key, r]));
  const active = [];
  const dismissed = [];
  const actedOn = [];
  opps.forEach((o) => {
    const s = states.get(o.key);
    if (!s) { active.push(o); return; }
    if (s.state === 'dismissed') {
      const worse = priorityRank(o.priority) > (cfg.PRIORITY_RANK[s.priority] || 0) || o.severity > (s.severity || 0);
      if (worse) active.push({ ...o, requalified: { previously_dismissed_at: new Date(s.acted_at).toISOString(), was_priority: s.priority, was_severity: s.severity } });
      else dismissed.push({ ...o, state: { state: 'dismissed', acted_at: new Date(s.acted_at).toISOString(), note: s.note } });
      return;
    }
    const ageDays = (now.getTime() - new Date(s.acted_at).getTime()) / 86400000;
    if (ageDays >= cfg.STATE.acted_on_review_days) active.push({ ...o, requalified: { previously_acted_on_at: new Date(s.acted_at).toISOString(), days_ago: Math.floor(ageDays) } });
    else actedOn.push({ ...o, state: { state: 'acted_on', acted_at: new Date(s.acted_at).toISOString(), note: s.note, shoot_plan_item_id: s.shoot_plan_item_id } });
  });
  return { active, dismissed, acted_on: actedOn };
}

// Seam for tests (and any future demand source): replace providers.demand to
// feed the engine different sales signals without touching ApparelMagic.
const providers = { demand: loadDemand };

async function computeAll({ now = new Date(), demand, db = pool } = {}) {
  const [snapshot, demandResult, stateRes] = await Promise.all([
    loadSnapshot(now, db),
    demand !== undefined ? Promise.resolve(demand) : providers.demand().catch((err) => ({ available: false, reason: `Sales data unavailable (${err.message})`, byProduct: new Map() })),
    db.query('SELECT * FROM creative_opportunity_states'),
  ]);
  const gen = generateOpportunities(snapshot, demandResult);
  const split = applyStates(gen.opportunities, stateRes.rows, now);
  return { snapshot, demand: demandResult, gen, split };
}

const STATE_FILTERS = new Set(['active', 'dismissed', 'acted_on', 'all']);
async function listOpportunities(query = {}, deps = {}) {
  const filter = STATE_FILTERS.has(query.state) ? query.state : 'active';
  const { snapshot, demand, gen, split } = await computeAll(deps);
  const list = filter === 'all' ? [...split.active, ...split.acted_on, ...split.dismissed] : split[filter];
  const byPriority = { Critical: 0, High: 0, Medium: 0 };
  split.active.forEach((o) => { byPriority[o.priority] += 1; });
  return {
    generated_at: new Date().toISOString(),
    config_version: cfg.VERSION,
    state: filter,
    window: { since: snapshot.win.evidence.since, until: snapshot.win.evidence.until, today: snapshot.win.today },
    counts: { active: split.active.length, dismissed: split.dismissed.length, acted_on: split.acted_on.length, by_priority: byPriority },
    data_status: {
      sales_available: !!demand.available,
      sales_note: demand.available ? null : `${demand.reason || 'Sales data unavailable'} — sales-based recommendations (strong / weak seller) are paused.`,
      classified_ads_used: snapshot.ads.length,
      meta_insights_through: snapshot.coverage.last_day,
      ads_included: 'confirmed + auto-matched only',
    },
    thresholds: { freshness: cfg.FRESHNESS, windows: cfg.WINDOWS, concept: cfg.CONCEPT, coverage: cfg.COVERAGE, concentration: cfg.CONCENTRATION, fatigue: cfg.FATIGUE, seller: cfg.SELLER, relevance: cfg.RELEVANCE, weak_seller: cfg.WEAK_SELLER, launch: cfg.LAUNCH, state: cfg.STATE },
    opportunities: list,
    concepts: gen.concepts,
  };
}

// Dismiss / acted-on / reopen. The server re-derives the opportunity itself
// (the client only names a key), so the stored fingerprint is always the
// truth at decision time.
async function setState({ key, state, note, shootPlanItemId, userId }, deps = {}) {
  if (!key || typeof key !== 'string' || key.length > 300) throw new HttpError(400, 'Invalid opportunity key');
  if (!['dismissed', 'acted_on', 'open'].includes(state)) throw new HttpError(400, 'state must be dismissed, acted_on or open');
  if (state === 'open') {
    await pool.query('DELETE FROM creative_opportunity_states WHERE opportunity_key = $1', [key]);
    return { key, state: 'open' };
  }
  const { gen } = await computeAll(deps);
  const opp = gen.opportunities.find((o) => o.key === key);
  if (!opp) throw new HttpError(404, 'That opportunity no longer applies');
  await pool.query(
    `INSERT INTO creative_opportunity_states (opportunity_key, rec_type, product_code, state, priority, severity, snapshot, note, shoot_plan_item_id, acted_by_user_id, acted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (opportunity_key) DO UPDATE SET state = EXCLUDED.state, priority = EXCLUDED.priority, severity = EXCLUDED.severity,
       snapshot = EXCLUDED.snapshot, note = EXCLUDED.note, shoot_plan_item_id = EXCLUDED.shoot_plan_item_id,
       acted_by_user_id = EXCLUDED.acted_by_user_id, acted_at = now()`,
    [key, opp.type, opp.products[0].product_code, state, opp.priority, opp.severity,
      JSON.stringify({ title: opp.title, explanation: opp.explanation, priority: opp.priority, severity: opp.severity, rank: opp.rank, recommended_concept: opp.recommended_concept, recommended_media: opp.recommended_media, evidence_summary: { sales: opp.evidence.sales, creative: opp.evidence.creative, meta: opp.evidence.meta }, generated_at: opp.generated_at }),
      note ? String(note).slice(0, 500) : null, shootPlanItemId ? parseInt(shootPlanItemId, 10) || null : null, userId || null]
  );
  return { key, state };
}

module.exports = {
  providers, INCLUDED_ADS_SQL, buildWindows, loadSnapshot, loadDemand, classifySellers, buildProductSignals, analyseConcepts,
  generateOpportunities, applyStates, computeAll, listOpportunities, setState, freshnessBand, launchDateOf, daysBetween,
  recTestConcepts, // reused by the Core creative plan (src/lib/coreCreativePlan.js)
};
