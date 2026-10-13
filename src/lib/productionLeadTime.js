// How long WNDRR's creative actually takes to go from "concept created" to "uploaded live", MEASURED from production timestamps (status_history). Information only: nothing in
// Planning uses it automatically. It exists so that creative_lead_time_days (Settings, Planning; 0 = off) can be set from evidence instead of a guess.
//   start  creative_assets.created_at (the concept record is created in Concept Development)
//   end    the FIRST status_history row that moved the asset to 'uploaded_live'
// Only assets that reached uploaded_live inside the window count. The median is reported with the number of concepts behind it; fewer than minSamples is "too few to rely on".
async function measureLeadTime(db, { days = 120, minSamples = 8 } = {}) {
  const r = (await db.query(
    `WITH first_live AS (
       SELECT DISTINCT ON (h.creative_asset_id) h.creative_asset_id, h.changed_at
         FROM status_history h WHERE h.to_status = 'uploaded_live' AND h.changed_at >= now() - ($1::int * interval '1 day')
        ORDER BY h.creative_asset_id, h.changed_at)
     SELECT count(*)::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (f.changed_at - a.created_at)) / 86400.0) AS median_days,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (f.changed_at - a.created_at)) / 86400.0) AS p90_days
       FROM first_live f JOIN creative_assets a ON a.id = f.creative_asset_id
      WHERE f.changed_at > a.created_at`, [days])).rows[0];
  const n = r.n || 0;
  return {
    window_days: days, concepts: n, reliable: n >= minSamples,
    median_days: n && r.median_days !== null ? Math.round(Number(r.median_days) * 10) / 10 : null, p90_days: n && r.p90_days !== null ? Math.round(Number(r.p90_days) * 10) / 10 : null,
    basis: 'concept created to first uploaded live, from status_history',
    note: n >= minSamples ? null : `Only ${n} concept${n === 1 ? '' : 's'} reached "uploaded live" in the last ${days} days, too few to rely on.`,
  };
}
module.exports = { measureLeadTime };
