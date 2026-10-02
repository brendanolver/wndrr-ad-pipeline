// Meta performance data layer, Phase 1: Meta -> database ONLY. Every call
// this file makes is a read-only Graph API GET (via metaAds.js's
// metaGet/metaGetAllPages, the same credential the live-ad-coverage
// feature already uses) -- nothing here creates, modifies, pauses,
// activates, or deletes anything in Meta, requests ads_management, or
// touches an existing WNDRR production table (creative_assets,
// final_edits, ad_setups are never written to by this file).
//
// Nothing in this file runs automatically. server.js does not call
// anything here on boot -- every sync (default-window or backfill) is
// triggered by an explicit, admin-only API call (src/routes/metaSync.js).
const { pool } = require('../db');
const { configured, metaGet, accountPath, metaGetAllPages } = require('./metaAds');
// Which Meta action_type counts as a Purchase / Add to Cart / purchase
// value, and which attribution window is requested, are provisional
// reporting choices isolated in ONE file -- see metaReportingConfig.js.
// Nothing in this file hard-codes any of them.
const {
  getConversionConfig, getAttributionWindows, getAttributionLabel, deriveConversions,
} = require('./metaReportingConfig');

const INSIGHTS_FIELDS = [
  'ad_id', 'impressions', 'reach', 'frequency', 'spend',
  'outbound_clicks', 'outbound_clicks_ctr',
  'actions', 'action_values',
  'video_play_actions', 'video_thruplay_watched_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p95_watched_actions', 'video_p100_watched_actions',
].join(',');

const AD_FIELDS = 'id,name,effective_status,campaign_id,adset_id,creative{id},created_time';

const BACKFILL_CHUNK_DAYS = 30;

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function accountId() {
  return accountPath().replace(/^\/act_/, '');
}

// Verified against the real WNDRR account's production diagnostic:
//  - outbound_clicks / outbound_clicks_ctr carry action_type 'outbound_click'
//  - video_play_actions carries action_type 'video_view'
// Those are matched by EXACT action_type only (no fallback) -- a missing
// entry is 0, never a guess from whatever else the array happens to hold.
function exactEntryValue(arr, actionType) {
  if (!Array.isArray(arr)) return 0;
  const match = arr.find((a) => a && a.action_type === actionType);
  return match ? Number(match.value) || 0 : 0;
}

// The remaining video_*_watched_actions fields (thruplay, p25/50/75/95/100)
// were NOT individually confirmed in that diagnostic -- only
// video_play_actions was. They follow the same documented 'video_view'
// convention, so exact match is preferred, with the array's first entry as
// a fallback because each of these fields is single-purpose. Confirm from
// the first real sync's stored values; if one turns out to carry a
// different action_type, change it here (these columns can be re-synced
// from Meta at any time -- unlike the conversion columns, there's no raw
// copy of these arrays stored).
function videoValue(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const match = arr.find((a) => a && a.action_type === 'video_view') || arr[0];
  return match ? Number(match.value) || 0 : 0;
}

function mapInsightsRow(row, currency) {
  return {
    meta_ad_id: row.ad_id,
    insight_date: row.date_start,
    impressions: Math.round(Number(row.impressions) || 0),
    reach: Math.round(Number(row.reach) || 0),
    frequency: row.frequency != null && row.frequency !== '' ? Number(row.frequency) : null,
    spend: Number(row.spend) || 0,
    outbound_clicks: Math.round(exactEntryValue(row.outbound_clicks, 'outbound_click')),
    outbound_ctr: Array.isArray(row.outbound_clicks_ctr) && row.outbound_clicks_ctr.length
      ? exactEntryValue(row.outbound_clicks_ctr, 'outbound_click') : null,
    ...deriveConversions(row.actions, row.action_values),
    video_plays: Math.round(exactEntryValue(row.video_play_actions, 'video_view')),
    thruplays: Math.round(videoValue(row.video_thruplay_watched_actions)),
    video_p25: Math.round(videoValue(row.video_p25_watched_actions)),
    video_p50: Math.round(videoValue(row.video_p50_watched_actions)),
    video_p75: Math.round(videoValue(row.video_p75_watched_actions)),
    video_p95: Math.round(videoValue(row.video_p95_watched_actions)),
    video_p100: Math.round(videoValue(row.video_p100_watched_actions)),
    raw_actions: row.actions ? JSON.stringify(row.actions) : null,
    raw_action_values: row.action_values ? JSON.stringify(row.action_values) : null,
    currency: currency || null,
    attribution_setting: getAttributionLabel(),
  };
}

// ON CONFLICT deliberately never touches match_status/matched_ad_setup_id/
// match_confidence/match_method/match_confirmed_at/match_confirmed_by_user_id
// -- discovery (this function) only ever refreshes Meta's own fields.
// A confirmed (or suggested) mapping survives every future discovery run
// untouched, forever (QA K).
async function upsertAd(ad) {
  const result = await pool.query(
    `INSERT INTO meta_ads (meta_ad_id, meta_adset_id, meta_campaign_id, meta_creative_id, ad_name, effective_status, created_time, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())
     ON CONFLICT (meta_ad_id) DO UPDATE SET
       meta_adset_id = EXCLUDED.meta_adset_id,
       meta_campaign_id = EXCLUDED.meta_campaign_id,
       meta_creative_id = EXCLUDED.meta_creative_id,
       ad_name = EXCLUDED.ad_name,
       effective_status = EXCLUDED.effective_status,
       last_seen_at = now(),
       updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [ad.meta_ad_id, ad.meta_adset_id, ad.meta_campaign_id, ad.meta_creative_id, ad.ad_name, ad.effective_status, ad.created_time]
  );
  return result.rows[0].inserted;
}

// A plain INSERT ... ON CONFLICT DO NOTHING shell -- guarantees the FK
// target in meta_ads exists before a daily insights row references it,
// for the rare case an ad has historical Insights data but wasn't (or is
// no longer) returned by the /ads discovery listing (e.g. a fully deleted
// ad). Never overwrites a real discovery row's data, and never touches
// match_* either.
async function ensureAdShell(metaAdId) {
  await pool.query(
    `INSERT INTO meta_ads (meta_ad_id, first_seen_at, last_seen_at)
     VALUES ($1, now(), now())
     ON CONFLICT (meta_ad_id) DO NOTHING`,
    [metaAdId]
  );
}

async function upsertDailyRow(row) {
  const result = await pool.query(
    `INSERT INTO meta_ad_insights_daily (
       meta_ad_id, insight_date, impressions, reach, frequency, spend,
       outbound_clicks, outbound_ctr, add_to_cart, purchases, purchase_value,
       video_plays, thruplays, video_p25, video_p50, video_p75, video_p95, video_p100,
       raw_actions, raw_action_values, currency, attribution_setting, fetched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
     ON CONFLICT (meta_ad_id, insight_date) DO UPDATE SET
       impressions = EXCLUDED.impressions,
       reach = EXCLUDED.reach,
       frequency = EXCLUDED.frequency,
       spend = EXCLUDED.spend,
       outbound_clicks = EXCLUDED.outbound_clicks,
       outbound_ctr = EXCLUDED.outbound_ctr,
       add_to_cart = EXCLUDED.add_to_cart,
       purchases = EXCLUDED.purchases,
       purchase_value = EXCLUDED.purchase_value,
       video_plays = EXCLUDED.video_plays,
       thruplays = EXCLUDED.thruplays,
       video_p25 = EXCLUDED.video_p25,
       video_p50 = EXCLUDED.video_p50,
       video_p75 = EXCLUDED.video_p75,
       video_p95 = EXCLUDED.video_p95,
       video_p100 = EXCLUDED.video_p100,
       raw_actions = EXCLUDED.raw_actions,
       raw_action_values = EXCLUDED.raw_action_values,
       currency = EXCLUDED.currency,
       attribution_setting = EXCLUDED.attribution_setting,
       fetched_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      row.meta_ad_id, row.insight_date, row.impressions, row.reach, row.frequency, row.spend,
      row.outbound_clicks, row.outbound_ctr, row.add_to_cart, row.purchases, row.purchase_value,
      row.video_plays, row.thruplays, row.video_p25, row.video_p50, row.video_p75, row.video_p95, row.video_p100,
      row.raw_actions, row.raw_action_values, row.currency, row.attribution_setting,
    ]
  );
  return result.rows[0].inserted;
}

async function fetchAccountSettings() {
  const result = await metaGet(accountPath(), {
    fields: 'name,currency,timezone_name,timezone_offset_hours_utc,account_status',
  });
  if (result.status !== 200) {
    const err = new Error(`Failed to fetch account settings: Meta returned status ${result.status}: ${JSON.stringify(result.data)}`);
    err.metaError = result.data;
    throw err;
  }
  return result.data;
}

async function upsertAccountSettings(info) {
  await pool.query(
    `INSERT INTO meta_account_settings (meta_ad_account_id, account_name, currency, timezone_name, timezone_offset_hours_utc, account_status, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (meta_ad_account_id) DO UPDATE SET
       account_name = EXCLUDED.account_name,
       currency = EXCLUDED.currency,
       timezone_name = EXCLUDED.timezone_name,
       timezone_offset_hours_utc = EXCLUDED.timezone_offset_hours_utc,
       account_status = EXCLUDED.account_status,
       fetched_at = now()`,
    [
      accountId(), info.name || null, info.currency || null, info.timezone_name || null,
      info.timezone_offset_hours_utc != null ? Number(info.timezone_offset_hours_utc) : null,
      info.account_status != null ? String(info.account_status) : null,
    ]
  );
}

// Discovery: deliberately NO effective_status filter -- requesting a
// specific status LIST (as the existing live-ad-coverage feature does,
// scoped to ['ACTIVE'] only) would narrow results, not broaden them.
// Omitting the filter asks Meta for its own default set, which needs
// confirming against this account's real ad count (see the Phase 1
// report) rather than assumed complete.
async function discoverAds() {
  let discovered = 0;
  let inserted = 0;
  let updated = 0;
  await metaGetAllPages(`${accountPath()}/ads`, { fields: AD_FIELDS, limit: '500' }, async (rows) => {
    for (const row of rows) {
      discovered += 1;
      const wasInserted = await upsertAd({
        meta_ad_id: row.id,
        meta_adset_id: row.adset_id || null,
        meta_campaign_id: row.campaign_id || null,
        meta_creative_id: (row.creative && row.creative.id) || null,
        ad_name: row.name || null,
        effective_status: row.effective_status || null,
        created_time: row.created_time || null,
      });
      if (wasInserted) inserted += 1; else updated += 1;
    }
  });
  return { discovered, inserted, updated };
}

async function fetchAndUpsertInsights(since, until, currency) {
  let rowsSeen = 0;
  let inserted = 0;
  let updated = 0;
  await metaGetAllPages(`${accountPath()}/insights`, {
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: INSIGHTS_FIELDS,
    action_attribution_windows: JSON.stringify(getAttributionWindows()),
    limit: '500',
  }, async (rows) => {
    for (const row of rows) {
      if (!row.ad_id || !row.date_start) continue;
      rowsSeen += 1;
      await ensureAdShell(row.ad_id);
      const wasInserted = await upsertDailyRow(mapInsightsRow(row, currency));
      if (wasInserted) inserted += 1; else updated += 1;
    }
  });
  return { rowsSeen, inserted, updated };
}

// One sync run = account settings refresh + full ad discovery + daily
// Insights for [since, until], logged start-to-finish in meta_sync_runs
// regardless of outcome. Discovery always runs in full (not scoped to the
// insights date range) so a confirmed/suggested mapping on an older ad
// still gets its name/status refreshed even on a narrow recent-window
// sync.
async function runSync({ since, until, runType = 'default', userId = null }) {
  if (!configured()) {
    throw new Error('Meta Ads is not configured (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN missing)');
  }
  const runInsert = await pool.query(
    `INSERT INTO meta_sync_runs (run_type, range_since, range_until, started_by_user_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [runType, since, until, userId]
  );
  const runId = runInsert.rows[0].id;

  try {
    const accountInfo = await fetchAccountSettings();
    await upsertAccountSettings(accountInfo);
    const discovery = await discoverAds();
    const insights = await fetchAndUpsertInsights(since, until, accountInfo.currency);

    await pool.query(
      `UPDATE meta_sync_runs SET
         ads_discovered = $1, ads_inserted = $2, ads_updated = $3,
         daily_rows_inserted = $4, daily_rows_updated = $5,
         status = 'success', finished_at = now()
       WHERE id = $6`,
      [discovery.discovered, discovery.inserted, discovery.updated, insights.inserted, insights.updated, runId]
    );
    return {
      run_id: runId, range: { since, until },
      ads_discovered: discovery.discovered, ads_inserted: discovery.inserted, ads_updated: discovery.updated,
      daily_rows_seen: insights.rowsSeen, daily_rows_inserted: insights.inserted, daily_rows_updated: insights.updated,
    };
  } catch (err) {
    await pool.query(
      `UPDATE meta_sync_runs SET status = 'failed', error_message = $1, finished_at = now() WHERE id = $2`,
      [String(err.message || err).slice(0, 2000), runId]
    );
    throw err;
  }
}

// Default window: today back 2 days (a 3-day span, inclusive) -- the
// small overlap refresh so recent attribution/conversion changes get
// re-pulled, per the brief's own suggested default.
function defaultWindow() {
  const until = new Date();
  until.setUTCHours(0, 0, 0, 0);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - 2);
  return { since: fmtDate(since), until: fmtDate(until) };
}

async function runDefaultSync(userId) {
  const { since, until } = defaultWindow();
  return runSync({ since, until, runType: 'default', userId });
}

function chunkRange(sinceStr, untilStr, chunkDays) {
  const chunks = [];
  let cursor = new Date(`${sinceStr}T00:00:00Z`);
  const end = new Date(`${untilStr}T00:00:00Z`);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ since: fmtDate(cursor), until: fmtDate(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

// Explicit-range only (no default), chunked into safe windows, run
// sequentially. Idempotent and resumable by construction: every chunk
// goes through the exact same upsert-on-conflict path as a normal sync,
// so re-running any chunk (including one that already partly succeeded)
// never duplicates a row. Stops at the first chunk that fails rather than
// continuing past an error -- re-calling with the remaining range is the
// safe way to resume.
async function runBackfill({ since, until, userId }) {
  const chunks = chunkRange(since, until, BACKFILL_CHUNK_DAYS);
  const results = [];
  for (const chunk of chunks) {
    try {
      const result = await runSync({ since: chunk.since, until: chunk.until, runType: 'backfill', userId });
      results.push({ ...chunk, ok: true, ...result });
    } catch (err) {
      results.push({ ...chunk, ok: false, error: err.message });
      break;
    }
  }
  return { chunks: results, completed: results.every((c) => c.ok) };
}

async function getSyncStatus() {
  const [lastRunResult, lastSuccessResult, matchCountsResult, dailyRangeResult, accountSettingsResult] = await Promise.all([
    pool.query('SELECT * FROM meta_sync_runs ORDER BY started_at DESC LIMIT 1'),
    pool.query(`SELECT * FROM meta_sync_runs WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1`),
    pool.query('SELECT match_status, count(*)::int AS count FROM meta_ads GROUP BY match_status'),
    pool.query('SELECT min(insight_date) AS min_date, max(insight_date) AS max_date, count(*)::int AS row_count FROM meta_ad_insights_daily'),
    pool.query('SELECT * FROM meta_account_settings ORDER BY fetched_at DESC LIMIT 1'),
  ]);

  const matchCounts = { unmatched: 0, suggested: 0, confirmed: 0 };
  for (const row of matchCountsResult.rows) matchCounts[row.match_status] = row.count;

  return {
    configured: configured(),
    account_settings: accountSettingsResult.rows[0] || null,
    last_run: lastRunResult.rows[0] || null,
    last_successful_run: lastSuccessResult.rows[0] || null,
    total_meta_ads: Object.values(matchCounts).reduce((a, b) => a + b, 0),
    match_counts: matchCounts,
    daily_insights: dailyRangeResult.rows[0] || null,
  };
}

// Recomputes purchases / add_to_cart / purchase_value for already-stored
// rows from their own stored raw_actions / raw_action_values, using
// whatever metaReportingConfig.js currently says -- no Meta call, no schema
// change, raw JSON untouched. This is the "change the canonical action
// type later" path: edit the config (or env var), redeploy, then call this
// for the date range to refresh the derived columns. Explicit range only,
// same as backfill; only rows whose derived values would actually change
// are written.
async function rederiveConversions({ since, until }) {
  const config = getConversionConfig();
  const rows = await pool.query(
    `SELECT id, raw_actions, raw_action_values, purchases, add_to_cart, purchase_value
     FROM meta_ad_insights_daily
     WHERE insight_date BETWEEN $1 AND $2 AND (raw_actions IS NOT NULL OR raw_action_values IS NOT NULL)`,
    [since, until]
  );
  let updated = 0;
  for (const row of rows.rows) {
    const next = deriveConversions(row.raw_actions, row.raw_action_values, config);
    if (
      Number(row.purchases) !== next.purchases
      || Number(row.add_to_cart) !== next.add_to_cart
      || Number(row.purchase_value) !== next.purchase_value
    ) {
      await pool.query(
        'UPDATE meta_ad_insights_daily SET purchases = $1, add_to_cart = $2, purchase_value = $3 WHERE id = $4',
        [next.purchases, next.add_to_cart, next.purchase_value, row.id]
      );
      updated += 1;
    }
  }
  return { range: { since, until }, rows_examined: rows.rows.length, rows_updated: updated, config_used: config };
}

// Reconciliation aid for production QA: totals EVERY purchase / add-to-cart
// related action_type Meta returned over a stored date range, side by side
// (counts from raw_actions, values from raw_action_values), plus which one
// is currently configured. Compare these against Ads Manager's own
// Purchases / Add to Cart / Purchase Value for the same range and
// attribution window to decide which alias WNDRR should standardise on.
async function conversionAliasTotals({ since, until }) {
  const [counts, values] = await Promise.all([
    pool.query(
      `SELECT a->>'action_type' AS action_type, sum((a->>'value')::numeric) AS total
       FROM meta_ad_insights_daily d, jsonb_array_elements(d.raw_actions) a
       WHERE d.insight_date BETWEEN $1 AND $2
         AND (a->>'action_type' ILIKE '%purchase%' OR a->>'action_type' ILIKE '%add_to_cart%')
       GROUP BY 1 ORDER BY 1`,
      [since, until]
    ),
    pool.query(
      `SELECT a->>'action_type' AS action_type, sum((a->>'value')::numeric) AS total
       FROM meta_ad_insights_daily d, jsonb_array_elements(d.raw_action_values) a
       WHERE d.insight_date BETWEEN $1 AND $2
         AND (a->>'action_type' ILIKE '%purchase%' OR a->>'action_type' ILIKE '%add_to_cart%')
       GROUP BY 1 ORDER BY 1`,
      [since, until]
    ),
  ]);
  return {
    range: { since, until },
    currently_configured: getConversionConfig(),
    attribution: getAttributionLabel(),
    action_counts: counts.rows.map((r) => ({ action_type: r.action_type, total: Number(r.total) })),
    action_values: values.rows.map((r) => ({ action_type: r.action_type, total: Number(r.total) })),
  };
}

module.exports = {
  runSync,
  runDefaultSync,
  runBackfill,
  getSyncStatus,
  rederiveConversions,
  conversionAliasTotals,
};
