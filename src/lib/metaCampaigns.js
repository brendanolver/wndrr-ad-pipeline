// Campaign names for Meta Performance. Read-only against Meta (GET <account>/campaigns); writes only meta_campaigns.
// meta_ads.meta_campaign_id is Meta's own campaign id for each ad, so ad -> campaign is exact; this only adds the
// campaign's NAME (and objective/status) and the literal funnel token read from it (see metaCampaignFunnel.js).
const { pool } = require('../db');
const metaAds = require('./metaAds');
const funnelLib = require('./metaCampaignFunnel');

const FIELDS = 'id,name,objective,status,effective_status';

async function upsert(row, db = pool) {
  const c = funnelLib.classify(row.name);
  await db.query(
    `INSERT INTO meta_campaigns (meta_campaign_id, name, objective, status, effective_status, funnel, funnel_rule_version, fetched_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())
     ON CONFLICT (meta_campaign_id) DO UPDATE SET name = EXCLUDED.name, objective = EXCLUDED.objective, status = EXCLUDED.status,
            effective_status = EXCLUDED.effective_status, funnel = EXCLUDED.funnel, funnel_rule_version = EXCLUDED.funnel_rule_version,
            fetched_at = now(), updated_at = now()`,
    [String(row.id), row.name || null, row.objective || null, row.status || null, row.effective_status || null, c.funnel, funnelLib.FUNNEL_RULE_VERSION]
  );
}

// One paged read of the account's campaigns (hundreds at most). Throws on a truncated listing so a partial list is
// never presented as complete; rows already stored are correct either way.
async function refreshCampaigns(deps = {}) {
  const db = deps.db || pool;
  const getPages = deps.metaGetAllPages || metaAds.metaGetAllPages;
  const accountPath = deps.accountPath || metaAds.accountPath;
  let count = 0;
  const paging = await getPages(`${accountPath()}/campaigns`, { fields: FIELDS, limit: '500' }, async (rows) => {
    for (const r of rows) {
      if (r && r.id) { await upsert(r, db); count += 1; }
    }
  });
  if (paging.stoppedReason !== 'end') throw new Error(`Meta campaigns pagination stopped early (${paging.stoppedReason})`);
  return { count };
}

// Recompute stored funnels whose rule version is older than the current one (local only, from the stored names).
async function ensureFunnels(db = pool) {
  const stale = await db.query('SELECT meta_campaign_id, name FROM meta_campaigns WHERE funnel_rule_version IS DISTINCT FROM $1', [funnelLib.FUNNEL_RULE_VERSION]);
  for (const r of stale.rows) {
    await db.query('UPDATE meta_campaigns SET funnel = $2, funnel_rule_version = $3 WHERE meta_campaign_id = $1', [r.meta_campaign_id, funnelLib.classify(r.name).funnel, funnelLib.FUNNEL_RULE_VERSION]);
  }
  return stale.rows.length;
}

async function lastFetchedAt(db = pool) {
  const r = await db.query('SELECT max(fetched_at) AS at, count(*)::int AS n FROM meta_campaigns');
  return { at: r.rows[0].at ? new Date(r.rows[0].at) : null, count: r.rows[0].n };
}

// Campaigns that had activity in the range (for the filter dropdown), with the ads / spend behind each.
const DROPDOWN_MAX = 300; // the dropdown lists the biggest spenders; the funnel filter and the table still cover every campaign
async function listForRange(range, db = pool) {
  await ensureFunnels(db);
  const { rows } = await db.query(
    `SELECT a.meta_campaign_id AS id, c.name, COALESCE(c.funnel, 'unknown') AS funnel,
            count(DISTINCT d.meta_ad_id)::int AS ads, COALESCE(sum(d.spend), 0)::float AS spend
       FROM meta_ad_insights_daily d JOIN meta_ads a ON a.meta_ad_id = d.meta_ad_id
       LEFT JOIN meta_campaigns c ON c.meta_campaign_id = a.meta_campaign_id
      WHERE d.insight_date BETWEEN $1 AND $2 AND (d.spend > 0 OR d.impressions > 0) AND a.meta_campaign_id IS NOT NULL
      GROUP BY a.meta_campaign_id, c.name, c.funnel
      ORDER BY spend DESC, a.meta_campaign_id`,
    [range.since, range.until]
  );
  const funnels = {};
  rows.forEach((r) => { funnels[r.funnel] = (funnels[r.funnel] || { campaigns: 0, ads: 0, spend: 0 }); funnels[r.funnel].campaigns += 1; funnels[r.funnel].ads += r.ads; funnels[r.funnel].spend += r.spend; });
  const noCampaign = await db.query(
    `SELECT count(DISTINCT d.meta_ad_id)::int AS ads FROM meta_ad_insights_daily d JOIN meta_ads a ON a.meta_ad_id = d.meta_ad_id
      WHERE d.insight_date BETWEEN $1 AND $2 AND (d.spend > 0 OR d.impressions > 0) AND a.meta_campaign_id IS NULL`, [range.since, range.until]);
  return { campaigns: rows.slice(0, DROPDOWN_MAX), campaigns_total: rows.length, truncated: rows.length > DROPDOWN_MAX, funnels, ads_without_campaign: noCampaign.rows[0].ads };
}

// What campaign naming patterns exist in the stored data (so the real WNDRR mapping can be defined afterwards).
async function patternCensus(db = pool) {
  await ensureFunnels(db);
  const camps = (await db.query('SELECT meta_campaign_id, name FROM meta_campaigns')).rows;
  const adStats = (await db.query(
    `SELECT count(*)::int AS ads, count(*) FILTER (WHERE a.meta_campaign_id IS NULL)::int AS ads_without_campaign_id,
            count(*) FILTER (WHERE a.meta_campaign_id IS NOT NULL AND c.meta_campaign_id IS NULL)::int AS ads_with_campaign_id_but_no_stored_name
       FROM meta_ads a LEFT JOIN meta_campaigns c ON c.meta_campaign_id = a.meta_campaign_id`)).rows[0];
  const fetched = await lastFetchedAt(db);
  return { ...funnelLib.census(camps), ads: adStats, campaign_names_fetched_at: fetched.at ? fetched.at.toISOString() : null, note: 'Only the literal tokens TOF / TOM / MOF are interpreted. Numbered structures (028, 081, ...) are listed as written and are not mapped to anything.' };
}

module.exports = { refreshCampaigns, ensureFunnels, lastFetchedAt, listForRange, patternCensus, upsert };
