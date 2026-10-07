// Is a creative running? Counted per UNIQUE creative (exact meta_creative_id), never per ad.
//
// WNDRR routinely duplicates one creative into many campaigns / ad sets, so "ads running" says nothing about how many
// distinct pieces of creative are in market. A creative is ACTIVE when at least one ad that uses that exact creative id --
// whether or not that particular ad has been classified -- is currently or recently delivering according to stored Insights:
//   * delivered (spend or impressions) within the last `recentDays` stored days, OR
//   * is ACTIVE and was created within the last NEW_AD_DAYS (too new to have Insights yet).
// When stored Insights are stale (the newest stored day is older than INSIGHTS_STALE_DAYS) delivery cannot be judged, so
// the ACTIVE status alone counts and the basis says 'status_only' (shown to the user as lower certainty).
// The number of ads behind an active creative is reported separately and never drives a recommendation.
const { pool } = require('../db');
const { addDays, REPORTING_TIMEZONE } = require('./metaPerformance');

const NEW_AD_DAYS = 3;
const INSIGHTS_STALE_DAYS = 3;

// keys: meta_creative_ids. Returns Map(creative_id -> facts over ALL ads sharing that exact id) and the newest stored day.
async function loadCreativeActivity(keys, { today, recentDays = 30, db = pool } = {}) {
  const ids = [...new Set((keys || []).filter(Boolean).map(String))];
  const latest = (await db.query("SELECT to_char(max(insight_date), 'YYYY-MM-DD') AS d FROM meta_ad_insights_daily")).rows[0].d || null;
  const out = new Map();
  if (!ids.length) return { byCreative: out, insights_last_day: latest };
  const since = addDays(today, -(recentDays - 1));
  const newSince = addDays(today, -(NEW_AD_DAYS - 1));
  const { rows } = await db.query(
    `SELECT m.meta_creative_id AS key, count(*)::int AS ads_total,
            count(*) FILTER (WHERE m.effective_status = 'ACTIVE')::int AS ads_active_status,
            count(*) FILTER (WHERE dl.last_delivery >= $2::date)::int AS ads_delivering,
            count(*) FILTER (WHERE m.effective_status = 'ACTIVE' AND m.created_time >= ($3::date)::timestamp AT TIME ZONE '${REPORTING_TIMEZONE}'
                              AND (dl.last_delivery IS NULL OR dl.last_delivery < $2::date))::int AS ads_new_active,
            count(*) FILTER (WHERE m.created_time IS NULL)::int AS ads_without_created,
            to_char(min(m.created_time AT TIME ZONE '${REPORTING_TIMEZONE}'), 'YYYY-MM-DD') AS first_created,
            to_char(max(dl.last_delivery), 'YYYY-MM-DD') AS last_delivery
       FROM meta_ads m
       LEFT JOIN (SELECT d.meta_ad_id, max(d.insight_date) FILTER (WHERE d.spend > 0 OR d.impressions > 0) AS last_delivery
                    FROM meta_ad_insights_daily d WHERE d.meta_ad_id IN (SELECT meta_ad_id FROM meta_ads WHERE meta_creative_id = ANY($1::text[])) GROUP BY d.meta_ad_id) dl
              ON dl.meta_ad_id = m.meta_ad_id
      WHERE m.meta_creative_id = ANY($1::text[])
      GROUP BY m.meta_creative_id`,
    [ids, since, newSince]
  );
  rows.forEach((r) => out.set(r.key, r));
  return { byCreative: out, insights_last_day: latest };
}

// Pure. act = one row from loadCreativeActivity; ctx = { today, insights_last_day }.
function verdict(act, ctx) {
  const fresh = !!ctx.insights_last_day && ctx.insights_last_day >= addDays(ctx.today, -INSIGHTS_STALE_DAYS);
  if (!act) return { active: false, active_ads: 0, basis: 'no_ads' };
  if (!fresh) return { active: act.ads_active_status > 0, active_ads: act.ads_active_status, basis: 'status_only' };
  const ads = act.ads_delivering + act.ads_new_active;
  return { active: ads > 0, active_ads: ads, basis: act.ads_delivering > 0 ? 'delivery' : act.ads_new_active > 0 ? 'new_active_ad' : 'none' };
}

module.exports = { loadCreativeActivity, verdict, NEW_AD_DAYS, INSIGHTS_STALE_DAYS };
