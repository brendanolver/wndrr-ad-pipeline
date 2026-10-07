// The DELIBERATE "Link to Meta creative" workflow for Inspiration references: a person searches stored Meta ads and chooses one.
// Kept apart from inspirationMetaLink.js on purpose -- that module is the deterministic (exact link / ad id only) recovery and
// must contain no name search at all. Here a name search only helps a human FIND candidates; nothing is ever linked from it
// without the explicit choose + press of Link, and nothing is matched automatically.
const { pool } = require('../db');

// Results are grouped by exact creative
// (one row per meta_creative_id, represented by its highest-spend ad) so duplicates of one creative are not a wall of rows.
async function searchMetaCreatives(q, db = pool) {
  const term = String(q || '').trim().slice(0, 100);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await db.query(
    `WITH hit_units AS (
       SELECT DISTINCT COALESCE(meta_creative_id, meta_ad_id) AS unit FROM meta_ads
        WHERE ad_name ILIKE $1 ESCAPE '\\' OR meta_ad_id = $2 OR meta_creative_id = $2
     ), per_ad AS (
       SELECT m.meta_ad_id, m.ad_name, m.effective_status, m.meta_creative_id, u.unit,
              COALESCE(sum(d.spend), 0) AS spend, max(d.insight_date) FILTER (WHERE d.spend > 0 OR d.impressions > 0) AS last_active
         FROM hit_units u JOIN meta_ads m ON COALESCE(m.meta_creative_id, m.meta_ad_id) = u.unit
         LEFT JOIN meta_ad_insights_daily d ON d.meta_ad_id = m.meta_ad_id
        GROUP BY m.meta_ad_id, m.ad_name, m.effective_status, m.meta_creative_id, u.unit
     ), ranked AS (
       SELECT p.*, row_number() OVER (PARTITION BY unit ORDER BY spend DESC, meta_ad_id) AS rn, count(*) OVER (PARTITION BY unit) AS ads,
              max(last_active) OVER (PARTITION BY unit) AS creative_last_active, bool_or(effective_status = 'ACTIVE') OVER (PARTITION BY unit) AS running,
              sum(spend) OVER (PARTITION BY unit) AS unit_spend
         FROM per_ad p)
     SELECT meta_ad_id, ad_name, effective_status, meta_creative_id, ads::int, to_char(creative_last_active, 'YYYY-MM-DD') AS creative_last_active, running, unit_spend::float AS spend
       FROM ranked WHERE rn = 1 ORDER BY unit_spend DESC, meta_ad_id LIMIT 20`, [like, term]);
  return rows;
}

async function manualLink(inspirationId, metaAdId, userId, db = pool) {
  const ad = (await db.query('SELECT meta_ad_id FROM meta_ads WHERE meta_ad_id = $1', [metaAdId])).rows[0];
  if (!ad) { const e = new Error('That Meta ad is not in the database.'); e.status = 404; throw e; }
  const r = await db.query(
    `UPDATE creative_inspiration SET meta_ad_id = $2, meta_link_basis = 'manual', meta_linked_at = now(), meta_linked_by_user_id = $3 WHERE id = $1 RETURNING id, meta_ad_id, meta_link_basis`,
    [inspirationId, metaAdId, userId || null]);
  if (!r.rows.length) { const e = new Error('Inspiration record not found'); e.status = 404; throw e; }
  return r.rows[0];
}
// Only a link a person made by hand can be removed this way; deterministic links are never silently undone.
async function manualUnlink(inspirationId, db = pool) {
  const r = await db.query(`UPDATE creative_inspiration SET meta_ad_id = NULL, meta_link_basis = NULL, meta_linked_at = NULL, meta_linked_by_user_id = NULL WHERE id = $1 AND meta_link_basis = 'manual' RETURNING id`, [inspirationId]);
  return r.rows.length > 0;
}

module.exports = { searchMetaCreatives, manualLink, manualUnlink };
