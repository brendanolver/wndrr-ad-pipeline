// Active Meta ad COVERAGE per product: how many distinct ads are live for it right now, against the minimum (default 5, editable in Settings).
//
// WHAT COUNTS (and nothing else):
//   * an ad whose Meta effective_status is exactly 'ACTIVE' (paused, campaign / ad-set paused, archived, deleted, pending, disapproved: never counted)
//   * that a person confirmed or the matcher auto-matched to the product (match_status confirmed / auto_matched -- the same "trusted ads" the Core plan
//     already uses), and that is not marked excluded from intelligence
//   * counted as DISTINCT meta_ad_id: one ad is one ad however many insight rows, creatives, colourways or product codes it has. Insight rows are not
//     read at all, so a duplicate row can never inflate a count.
//   * a product family is all of its product codes (colourways and season codes): an ad linked to several codes of one family counts once for it.
//   An ad linked to SEVERAL different products (a bundle / multi-product ad) counts once toward EACH of them -- it really is live for each. Totals across
//   products are therefore not additive; per-product counts are exact.
// HOW RELIABLE IS A COUNT (added after review): a product's count only includes ads a person confirmed or the matcher auto-matched. Active ads that are
// STILL AWAITING REVIEW (Needs review / Unmatched) are not in it, yet some of them may really belong to that product. So the loader also reports, per
// product, how many awaiting-review ads carry a product suggestion for it, and how many carry NO product suggestion at all (those could be anyone's).
// classify() then asks the honest question -- "could this product actually reach the minimum if those ads were reviewed?":
//   meets      confirmed >= minimum
//   below      even if EVERY pending ad that might be this product's were, the count would stay under the minimum (a reliable shortage)
//   uncertain  confirmed < minimum but confirmed + awaiting-review ads SUGGESTED FOR THIS PRODUCT >= minimum: the count may be incomplete; NOT proof of a shortage
//   (Batch 14: awaiting-review ads that carry NO product suggestion at all are reported account-wide but are NOT added to every product's upper bound. Counting
//    them made nearly every product "uncertain" the moment the account had a few unreviewed ads, because the same unattributed ads were counted for all of them.)
// WHAT THIS IS NOT: the total number of creatives ever made for the product (that is history, shown elsewhere), nor distinct creatives -- it is live ads.
//
// STATUS FRESHNESS: effective_status is whatever the last ad-inventory refresh stored. The result says when that was (status_as_of) so a stale count is
// visible. If no Meta ads are stored at all the count is "unavailable" (never reported as zero active ads).
// Local database only; read-only.
const { pool } = require('../db');
const dpaLib = require('./metaDpa'); // Dynamic Product Ads are not a product's creative: never counted (nothing is deleted, they are only left out here)

const DAY = 86400000;

// pure: families [{ key, codes[] }], pairs [{ product_code, meta_ad_id }] -> Map(familyKey -> distinct active ad count)
function countByFamily(families, pairs) {
  const codeToFamily = new Map();
  families.forEach((f) => (f.codes || [f.key]).forEach((c) => codeToFamily.set(c, f.key)));
  const sets = new Map();
  pairs.forEach((p) => {
    const k = codeToFamily.get(p.product_code);
    if (!k) return;
    if (!sets.has(k)) sets.set(k, new Set());
    sets.get(k).add(p.meta_ad_id);
  });
  const out = new Map();
  families.forEach((f) => out.set(f.key, sets.has(f.key) ? sets.get(f.key).size : 0));
  return out;
}

// pure: one product's coverage state (see HOW RELIABLE IS A COUNT)
function classify({ confirmed, possible = 0, unattributed = 0, min }) {
  const n = Math.max(0, Math.round(Number(confirmed) || 0)); const m = Math.max(1, Math.round(Number(min) || 5));
  const p = Math.max(0, Math.round(Number(possible) || 0)); const u = Math.max(0, Math.round(Number(unattributed) || 0));
  if (n >= m) return { state: 'meets', confirmed: n, min: m, possible: p, unattributed: u, upper_bound: n + p };
  const upper = n + p; // only ads with evidence pointing at THIS product can close its gap; unattributed ads (u) are context, not evidence for any one product
  return { state: upper >= m ? 'uncertain' : 'below', confirmed: n, min: m, possible: p, unattributed: u, upper_bound: upper, likely_meets: n + p >= m };
}

// pure: families [{ key, codes[] }], pending [{ meta_ad_id, suggested_codes[] }] -> { by_family: Map(key -> distinct pending ads suggested for it), unattributed }
function pendingByFamily(families, pending) {
  const codeToFamily = new Map();
  families.forEach((f) => (f.codes || [f.key]).forEach((c) => codeToFamily.set(c, f.key)));
  const sets = new Map(); let unattributed = 0;
  (pending || []).forEach((a) => {
    const codes = (a.suggested_codes || []).filter(Boolean);
    if (!codes.length) { unattributed += 1; return; }
    codes.forEach((c) => { const k = codeToFamily.get(c); if (!k) return; if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(a.meta_ad_id); });
  });
  const out = new Map(); families.forEach((f) => out.set(f.key, sets.has(f.key) ? sets.get(f.key).size : 0));
  return { by_family: out, unattributed };
}

async function loadActiveAdCoverage(families, { db = pool, min, now = new Date() } = {}) {
  const meta = (await db.query('SELECT count(*)::int AS ads, max(last_seen_at) AS last_seen FROM meta_ads')).rows[0];
  if (!meta.ads) return { available: false, reason: 'No Meta ads are stored yet, so active ad counts are unavailable', min };
  const codes = [...new Set(families.flatMap((f) => f.codes || [f.key]))];
  const pairs = codes.length ? (await db.query(
    `SELECT DISTINCT p.product_code, m.meta_ad_id
       FROM meta_ad_products p
       JOIN meta_ads m ON m.meta_ad_id = p.meta_ad_id
       LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.effective_status = 'ACTIVE'
        AND m.match_status IN ('confirmed', 'auto_matched')
        AND NOT COALESCE(c.excluded_from_intelligence, false)
        AND ${dpaLib.notDpaStandalone('m')}
        AND p.product_code = ANY($1::text[])`, [codes])).rows : [];
  // ACTIVE ads that nobody has reviewed yet: they are not counted, but they are why a count may be incomplete
  const pendingRows = (await db.query(
    `SELECT m.meta_ad_id,
            (SELECT array_agg(DISTINCT s.value_key) FROM meta_ad_suggestions s WHERE s.meta_ad_id = m.meta_ad_id AND s.field = 'product') AS suggested_codes
       FROM meta_ads m
       LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.effective_status = 'ACTIVE'
        AND m.match_status IN ('unmatched', 'suggested')
        AND NOT COALESCE(c.excluded_from_intelligence, false)
        AND ${dpaLib.notDpaStandalone('m')}`)).rows;
  const pend = pendingByFamily(families, pendingRows);
  const trustedActive = (await db.query(
    `SELECT count(DISTINCT m.meta_ad_id)::int AS n FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.effective_status = 'ACTIVE' AND m.match_status IN ('confirmed', 'auto_matched') AND NOT COALESCE(c.excluded_from_intelligence, false) AND ${dpaLib.notDpaStandalone('m')}`)).rows[0].n;
  const activeTotal = trustedActive + pendingRows.length;
  const lastSeen = meta.last_seen ? new Date(meta.last_seen) : null;
  const staleDays = lastSeen ? Math.floor((now.getTime() - lastSeen.getTime()) / DAY) : null;
  return {
    available: true, min, by_family: countByFamily(families, pairs), pending_by_family: pend.by_family, unattributed_pending: pend.unattributed,
    reliability: {
      active_ads: activeTotal, confirmed_or_auto: trustedActive, awaiting_review: pendingRows.length, awaiting_review_without_product: pend.unattributed,
      share_awaiting_review: activeTotal ? Math.round((pendingRows.length / activeTotal) * 1000) / 10 : 0,
      complete: pendingRows.length === 0,
    }, status_as_of: lastSeen ? lastSeen.toISOString() : null, stale_days: staleDays,
    stale: staleDays !== null && staleDays > 3, total_active_links: pairs.length,
    note: 'Counts distinct ACTIVE Meta ads (confirmed or auto-matched to the product, not excluded); paused, archived and deleted ads are not counted. Active ads still awaiting review are reported separately: until they are reviewed a product\'s count may be incomplete.',
  };
}

module.exports = { countByFamily, classify, pendingByFamily, loadActiveAdCoverage };
