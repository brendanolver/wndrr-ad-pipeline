// A product's PAST creative winners: unique creatives that, over their life in the stored Meta data, ran within an APPROVED benchmark (today: MOF CPA at or under
// the approved green limit). Used for two things only: telling a High Stocks revival what used to work, and giving a recommendation a creative direction that is
// backed by this product's own history.
//
// HONESTY: daily Meta insights only go back to when syncing started, so "history" means the stored window, not the product's whole life, and every result says so.
// A creative is a winner only against an approved benchmark (never a number invented here); a funnel with no approved CPA benchmark yields no winners.
const dpaLib = require('./metaDpa');
const health = require('./metaFunnelHealth');
const perf = require('./productAdPerformance');

const num = (v) => Number(v) || 0;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// → Map(familyKey -> { available, from, winners: [{ key, concept, creator, media, cpa, spend, purchases, ads, last_delivery, running_now }] (best CPA first, at most 3) })
async function loadCreativeHistory(families, { db, rules, coded, today, config = perf.DEFAULTS, nameCopies = null, lookbackDays = 365 } = {}) {
  const codeToFamily = new Map();
  families.forEach((f) => (f.codes || [f.key]).forEach((c) => codeToFamily.set(c, f.key)));
  const out = new Map(); families.forEach((f) => out.set(f.key, { available: true, from: null, winners: [] }));
  const codes = [...codeToFamily.keys()];
  if (!codes.length) return out;
  const from = addDays(today, -lookbackDays);
  const rows = (await db.query(
    `SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.effective_status, c.funnel, cl.concept_label, cl.creator_name, cl.media_type,
            (SELECT array_agg(DISTINCT p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id) AS product_codes,
            COALESCE(SUM(d.spend), 0) AS spend, COALESCE(SUM(d.purchases), 0) AS purchases, COALESCE(SUM(d.impressions), 0) AS impressions, MAX(d.insight_date) AS last_delivery
       FROM meta_ads m
       LEFT JOIN meta_ad_classifications cl ON cl.meta_ad_id = m.meta_ad_id
       LEFT JOIN meta_campaigns c ON c.meta_campaign_id = m.meta_campaign_id
       LEFT JOIN meta_ad_insights_daily d ON d.meta_ad_id = m.meta_ad_id AND d.insight_date >= $2
      WHERE m.match_status IN ('confirmed', 'auto_matched') AND NOT COALESCE(cl.excluded_from_intelligence, false)
        AND NOT COALESCE((${dpaLib.dpaPredicate('m', 'c')}), false)
        AND EXISTS (SELECT 1 FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id AND p.product_code = ANY($1::text[]))
      GROUP BY m.meta_ad_id, m.ad_name, m.meta_creative_id, m.effective_status, c.funnel, cl.concept_label, cl.creator_name, cl.media_type`,
    [codes, from])).rows;
  const per = new Map();
  rows.forEach((r) => {
    const fams = [...new Set((r.product_codes || []).map((c) => codeToFamily.get(c)).filter(Boolean))];
    fams.forEach((fk) => {
      if (!per.has(fk)) per.set(fk, new Map());
      const g = per.get(fk); const key = perf.creativeGroupKey(r, nameCopies);
      if (!g.has(key)) g.set(key, { key, spend: 0, purchases: 0, impressions: 0, ads: 0, active: false, last: null, funnels: new Set(), concept: null, creator: null, media: null });
      const x = g.get(key);
      x.spend += num(r.spend); x.purchases += num(r.purchases); x.impressions += num(r.impressions); x.ads += 1;
      if (r.effective_status === 'ACTIVE') x.active = true;
      if (r.last_delivery && (!x.last || String(r.last_delivery) > x.last)) x.last = String(r.last_delivery).slice(0, 10);
      if (r.funnel) x.funnels.add(r.funnel);
      x.concept = x.concept || r.concept_label || null; x.creator = x.creator || r.creator_name || null; x.media = x.media || r.media_type || null;
    });
  });
  per.forEach((g, fk) => {
    const winners = [];
    g.forEach((x) => {
      const funnel = x.funnels.size === 1 ? [...x.funnels][0] : null;
      if (!funnel || !['TOF', 'TOM', 'MOF'].includes(funnel)) return;
      if (x.spend < config.min_spend * 2 || x.purchases < 3) return; // enough lifetime evidence to call it a winner
      const cpa = x.spend / x.purchases;
      if (health.classify(funnel, 'cpa', cpa, {}, { rules, coded }) !== 'green') return;
      const running = x.active && x.last && x.last >= addDays(today, -7);
      winners.push({ key: x.key, concept: x.concept, creator: x.creator, media: x.media, funnel, cpa: Math.round(cpa * 100) / 100, spend: Math.round(x.spend), purchases: Math.round(x.purchases), ads: x.ads, last_delivery: x.last, running_now: !!running });
    });
    winners.sort((a, b) => a.cpa - b.cpa);
    out.set(fk, { available: true, from, winners: winners.slice(0, 3) });
  });
  return out;
}

module.exports = { loadCreativeHistory };
