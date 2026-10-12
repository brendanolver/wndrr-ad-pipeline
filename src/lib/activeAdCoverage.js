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
// WHAT THIS IS NOT: the total number of creatives ever made for the product (that is history, shown elsewhere), nor distinct creatives -- it is live ads.
//
// STATUS FRESHNESS: effective_status is whatever the last ad-inventory refresh stored. The result says when that was (status_as_of) so a stale count is
// visible. If no Meta ads are stored at all the count is "unavailable" (never reported as zero active ads).
// Local database only; read-only.
const { pool } = require('../db');

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
        AND p.product_code = ANY($1::text[])`, [codes])).rows : [];
  const lastSeen = meta.last_seen ? new Date(meta.last_seen) : null;
  const staleDays = lastSeen ? Math.floor((now.getTime() - lastSeen.getTime()) / DAY) : null;
  return {
    available: true, min, by_family: countByFamily(families, pairs), status_as_of: lastSeen ? lastSeen.toISOString() : null, stale_days: staleDays,
    stale: staleDays !== null && staleDays > 3, total_active_links: pairs.length,
    note: 'Counts distinct ACTIVE Meta ads (confirmed or auto-matched to the product, not excluded); paused, archived and deleted ads are not counted.',
  };
}

module.exports = { countByFamily, loadActiveAdCoverage };
