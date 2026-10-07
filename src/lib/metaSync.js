// Meta performance data layer, Phase 1: Meta -> database ONLY. Every call
// this file makes is a read-only Graph API GET (via metaAds.js's
// metaGet/metaGetAllPages, the same credential the live-ad-coverage
// feature already uses) -- nothing here creates, modifies, pauses,
// activates, or deletes anything in Meta, requests ads_management, or
// touches an existing WNDRR production table (creative_assets,
// final_edits, ad_setups are never written to by this file).
//
// Nothing in this file schedules itself. The ONLY automatic caller is
// lib/metaAutoSync.js, which runs the routine performance sync (Job A) over a
// short rolling recent window and nothing else; backfill, the full inventory
// refresh and everything else are triggered by an explicit, admin-only API
// call (src/routes/metaSync.js).
//
// TWO separate jobs, deliberately never combined:
//   A. Routine performance sync (runSync / runDefaultSync / runBackfill):
//      account settings + daily ad-level Insights for a date range, plus a
//      metadata lookup ONLY for ads that appear in those Insights but have
//      no meta_ads identity yet. Cost is proportional to the date range --
//      never to the ~30k-ad historical inventory -- so it is safe to
//      schedule later.
//   B. Full inventory refresh (refreshInventory): pages through EVERY ad in
//      the account to refresh names/statuses/IDs and pick up historical
//      ads. Heavy (~60 calls at 500/page for ~30k ads), explicit admin
//      action only, never part of A.
const { pool } = require('../db');
const {
  configured, metaGet, accountPath, metaGetAllPages, metaGetByIds, buildMetaApiError, MetaApiError, RATE_LIMIT_MESSAGE,
} = require('./metaAds');
const { ymdInZone, addDays, REPORTING_TIMEZONE } = require('./metaPerformance');
// Which Meta action_type counts as a Purchase / Add to Cart / purchase
// value (verified against Ads Manager) and which attribution window is
// requested (still provisional) are isolated in ONE file -- see
// metaReportingConfig.js. Nothing in this file hard-codes any of them.
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
// Graph API multi-id reads accept up to 50 ids per request.
const AD_LOOKUP_BATCH = 50;
// Used only when Meta gave no retry hint with a rate-limit response.
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 300;

// In-process cooldown after a rate-limit response. While it is active every
// Meta-touching action here fails fast WITHOUT calling Meta, so a second
// click (or a future scheduler) can't pile more calls onto an account that
// just told us to wait. Memory only: a restart clears it, which is fine --
// the real limit lives on Meta's side and is re-detected on the next call.
let rateLimitedUntil = 0;

function noteRateLimit(err) {
  if (err && err.rateLimited) {
    const seconds = err.retryAfterSeconds || DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS;
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + seconds * 1000);
  }
}

function assertNotRateLimited() {
  const remaining = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
  if (remaining > 0) {
    throw new MetaApiError(RATE_LIMIT_MESSAGE, { rateLimited: true, retryAfterSeconds: remaining });
  }
}

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
       -- created_time never changes on Meta's side, so only FILL it when absent
       -- (an id-only shell created for an ad seen in Insights before its
       -- metadata was fetched) -- never overwrite a stored value.
       created_time = COALESCE(meta_ads.created_time, EXCLUDED.created_time),
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
  if (result.status !== 200) throw buildMetaApiError(result, 'Account settings request');
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

// Full-inventory discovery (job B only -- see refreshInventory). Deliberately
// NO effective_status filter -- requesting a specific status LIST (as the
// existing live-ad-coverage feature does, scoped to ['ACTIVE'] only) would
// narrow results, not broaden them. Omitting the filter asks Meta for its
// own default set (production confirmed: ~29.7k ads back to 2019).
async function discoverAds() {
  let discovered = 0;
  let inserted = 0;
  let updated = 0;
  const paging = await metaGetAllPages(`${accountPath()}/ads`, { fields: AD_FIELDS, limit: '500' }, async (rows) => {
    for (const row of rows) {
      discovered += 1;
      const wasInserted = await upsertAd(adFromMeta(row));
      if (wasInserted) inserted += 1; else updated += 1;
    }
  });
  return { discovered, inserted, updated, pages: paging.pages, stoppedReason: paging.stoppedReason };
}

function adFromMeta(row) {
  return {
    meta_ad_id: row.id,
    meta_adset_id: row.adset_id || null,
    meta_campaign_id: row.campaign_id || null,
    meta_creative_id: (row.creative && row.creative.id) || null,
    ad_name: row.name || null,
    effective_status: row.effective_status || null,
    created_time: row.created_time || null,
  };
}

// For one page of Insights rows: guarantees every referenced ad has a
// meta_ads row (the FK target) and reports which of them still lack real
// metadata. An ad "needs a lookup" when it has no meta_ads row at all, or
// only an id-only shell (ad_name IS NULL, e.g. an earlier lookup failed).
// A known ad -- the normal case, ~every ad in a routine window -- costs one
// local SELECT per page and NO Meta call. Never touches match_*.
async function ensureIdentitiesForPage(adIds, needLookup, counters) {
  if (!adIds.length) return;
  const known = await pool.query(
    'SELECT meta_ad_id, ad_name FROM meta_ads WHERE meta_ad_id = ANY($1)',
    [adIds]
  );
  const byId = new Map(known.rows.map((r) => [r.meta_ad_id, r.ad_name]));
  for (const id of adIds) {
    if (!byId.has(id)) {
      await ensureAdShell(id);
      counters.newIdentities += 1;
      needLookup.add(id);
    } else if (byId.get(id) === null) {
      needLookup.add(id);
    }
  }
}

// Fetches metadata for ONLY the given ad ids, in batches of up to 50 per
// call (`/?ids=...`) -- never a full-account listing. A rate limit aborts
// (thrown); any other failure leaves those ads as id-only shells (their
// daily rows are already safely stored) and is reported, not fatal.
async function lookupMissingAds(ids) {
  const out = { requested: ids.length, resolved: 0, unresolved: 0, calls: 0 };
  for (let i = 0; i < ids.length; i += AD_LOOKUP_BATCH) {
    const batch = ids.slice(i, i + AD_LOOKUP_BATCH);
    let map;
    try {
      out.calls += 1;
      map = await metaGetByIds(batch, AD_FIELDS);
    } catch (err) {
      if (err.rateLimited) throw err;
      out.unresolved += batch.length;
      continue;
    }
    for (const id of batch) {
      const row = map[id];
      if (row && row.id) {
        await upsertAd(adFromMeta(row));
        out.resolved += 1;
      } else {
        out.unresolved += 1;
      }
    }
  }
  return out;
}

async function fetchAndUpsertInsights(since, until, currency) {
  let rowsSeen = 0;
  let inserted = 0;
  let updated = 0;
  const counters = { newIdentities: 0 };
  const needLookup = new Set();
  const paging = await metaGetAllPages(`${accountPath()}/insights`, {
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: INSIGHTS_FIELDS,
    action_attribution_windows: JSON.stringify(getAttributionWindows()),
    limit: '500',
  }, async (rows) => {
    const valid = rows.filter((r) => r.ad_id && r.date_start);
    await ensureIdentitiesForPage([...new Set(valid.map((r) => r.ad_id))], needLookup, counters);
    for (const row of valid) {
      rowsSeen += 1;
      const wasInserted = await upsertDailyRow(mapInsightsRow(row, currency));
      if (wasInserted) inserted += 1; else updated += 1;
    }
  });
  // A truncated Insights listing must never be recorded as a successful
  // sync: the coverage logic treats a successful run as "these days are
  // fully in", so an early stop here is a failure (rows already stored are
  // correct and idempotent; the run just doesn't claim coverage).
  if (paging.stoppedReason !== 'end') {
    throw new Error(`Meta Insights pagination stopped early (${paging.stoppedReason}); this run is not recorded as synced. Existing data is safe.`);
  }
  return { rowsSeen, inserted, updated, newIdentities: counters.newIdentities, needLookup: [...needLookup] };
}


// Only ONE performance/inventory run may be active at a time. The check and
// the INSERT happen under a transaction-scoped Postgres advisory lock, so two
// callers (a manual click and the automatic scheduler, or two server
// instances) can never both pass the check and start overlapping runs. A
// 'running' row older than STALE_RUN_MINUTES is treated as a crashed run and
// does not block (it is left in the log as it is).
const SYNC_LOCK_KEY = 7310001;
const STALE_RUN_MINUTES = 30;

async function startRunExclusive({ runType, since, until, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY]);
    const active = await client.query(
      `SELECT id FROM meta_sync_runs
       WHERE status = 'running' AND started_at > now() - ($1 || ' minutes')::interval LIMIT 1`,
      [String(STALE_RUN_MINUTES)]
    );
    if (active.rows.length) {
      await client.query('ROLLBACK');
      const err = new Error('Another Meta sync is already running. Wait for it to finish, then try again.');
      err.code = 'SYNC_IN_PROGRESS';
      err.safe = true;
      throw err;
    }
    const inserted = await client.query(
      `INSERT INTO meta_sync_runs (run_type, range_since, range_until, started_by_user_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [runType, since, until, userId]
    );
    await client.query('COMMIT');
    return inserted.rows[0].id;
  } catch (err) {
    if (err.code !== 'SYNC_IN_PROGRESS') await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Job A: routine performance sync for [since, until], logged start-to-
// finish in meta_sync_runs regardless of outcome.
//   account settings (1 call) -> daily ad-level Insights (paged) -> for ads
//   in those Insights with no meta_ads identity: fetch just those ads'
//   metadata by id.
// It does NOT list or upsert the account's ad inventory, so the
// ~29.7k existing meta_ads rows are never touched here (names/statuses of
// ads that have no new Insights only refresh via refreshInventory).
async function runSync({ since, until, runType = 'default', userId = null }) {
  if (!configured()) {
    throw new Error('Meta Ads is not configured (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN missing)');
  }
  assertNotRateLimited();
  const runId = await startRunExclusive({ runType, since, until, userId });

  try {
    const accountInfo = await fetchAccountSettings();
    await upsertAccountSettings(accountInfo);
    const insights = await fetchAndUpsertInsights(since, until, accountInfo.currency);
    const lookup = await lookupMissingAds(insights.needLookup);

    // ads_discovered / ads_inserted / ads_updated keep their column meaning
    // for the run log: ads whose metadata was needed, ads that gained a
    // brand-new meta_ads identity, and previously id-only shells filled in.
    const adsDiscovered = lookup.requested;
    const adsInserted = insights.newIdentities;
    const adsUpdated = Math.max(0, lookup.resolved - insights.newIdentities);
    await pool.query(
      `UPDATE meta_sync_runs SET
         ads_discovered = $1, ads_inserted = $2, ads_updated = $3,
         daily_rows_inserted = $4, daily_rows_updated = $5,
         status = 'success', finished_at = now()
       WHERE id = $6`,
      [adsDiscovered, adsInserted, adsUpdated, insights.inserted, insights.updated, runId]
    );
    return {
      run_id: runId, range: { since, until },
      daily_rows_seen: insights.rowsSeen, daily_rows_inserted: insights.inserted, daily_rows_updated: insights.updated,
      new_ads_identified: insights.newIdentities,
      ad_metadata_lookups: { requested: lookup.requested, resolved: lookup.resolved, unresolved: lookup.unresolved, calls: lookup.calls },
    };
  } catch (err) {
    noteRateLimit(err);
    await failRun(runId, err);
    throw err;
  }
}

// Failure bookkeeping: only the already-safe message is stored (a
// MetaApiError's message is sanitised at source; anything else is
// URL-stripped and length-capped).
async function failRun(runId, err) {
  const message = err && err.safe ? err.message : String((err && err.message) || err).replace(/https?:\/\/\S+/g, '[url removed]');
  await pool.query(
    `UPDATE meta_sync_runs SET status = 'failed', error_message = $1, finished_at = now() WHERE id = $2`,
    [message.slice(0, 500), runId]
  );
}

// Job B: explicit full-inventory refresh. Idempotent upsert keyed on the
// stable meta_ad_id: refreshes Meta-owned fields (name, status, ids,
// last_seen_at) and inserts historical ads not yet stored. Never deletes a
// meta_ads row and never touches match_* (see upsertAd), so confirmed
// mappings survive. Logged in meta_sync_runs as run_type 'inventory' --
// excluded from every "which days are synced" calculation because it pulls
// no Insights (see metaPerformance.getCoverage). Progress is upserted as it
// goes, so a rate limit midway leaves everything fetched so far stored.
async function refreshInventory({ userId = null } = {}) {
  if (!configured()) {
    throw new Error('Meta Ads is not configured (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN missing)');
  }
  assertNotRateLimited();
  const today = ymdInZone(new Date(), REPORTING_TIMEZONE);
  const runId = await startRunExclusive({ runType: 'inventory', since: today, until: today, userId });
  try {
    const discovery = await discoverAds();
    await pool.query(
      `UPDATE meta_sync_runs SET ads_discovered = $1, ads_inserted = $2, ads_updated = $3,
         status = 'success', finished_at = now() WHERE id = $4`,
      [discovery.discovered, discovery.inserted, discovery.updated, runId]
    );
    return {
      run_id: runId,
      ads_discovered: discovery.discovered, ads_inserted: discovery.inserted, ads_updated: discovery.updated,
      pages: discovery.pages,
      // 'end' = listing completed; anything else means Meta's cursor looped
      // and the listing is INCOMPLETE (rows fetched so far are stored).
      complete: discovery.stoppedReason === 'end',
      stopped_reason: discovery.stoppedReason,
    };
  } catch (err) {
    noteRateLimit(err);
    await failRun(runId, err);
    throw err;
  }
}

// Default window: Sydney today back 2 days (a 3-day span, inclusive) -- the
// small overlap refresh so recent attribution/conversion changes get
// re-pulled, per the brief's own suggested default. Calendar dates are
// resolved in the account reporting timezone (Australia/Sydney, the same
// single constant Meta Performance uses), NOT the UTC date: Meta buckets
// insight days in the ad account's timezone, so at 9am Sydney on 5 Oct the
// window must be 3-5 Oct (UTC would still say 4 Oct and request 2-4 Oct).
// `now` is injectable only so the Sydney/UTC/DST boundaries can be tested.
function defaultWindow(now = new Date()) {
  const until = ymdInZone(now, REPORTING_TIMEZONE);
  return { since: addDays(until, -2), until };
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
      results.push({ ...chunk, ok: false, error: err.safe ? err.message : String(err.message || err).replace(/https?:\/\/\S+/g, '[url removed]').slice(0, 300), rate_limited: !!err.rateLimited });
      break;
    }
  }
  return { chunks: results, completed: results.every((c) => c.ok) };
}

async function getSyncStatus() {
  // last_run / last_successful_run describe PERFORMANCE syncs only
  // (default + backfill); inventory refreshes are reported separately so a
  // maintenance refresh never reads as "performance data was synced".
  const [lastRunResult, lastSuccessResult, lastInventoryResult, matchCountsResult, dailyRangeResult, accountSettingsResult] = await Promise.all([
    pool.query(`SELECT * FROM meta_sync_runs WHERE run_type IN ('default','backfill') ORDER BY started_at DESC LIMIT 1`),
    pool.query(`SELECT * FROM meta_sync_runs WHERE run_type IN ('default','backfill') AND status = 'success' ORDER BY finished_at DESC LIMIT 1`),
    pool.query(`SELECT * FROM meta_sync_runs WHERE run_type = 'inventory' AND status = 'success' ORDER BY finished_at DESC LIMIT 1`),
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
    last_inventory_refresh: lastInventoryResult.rows[0] || null,
    // Seconds left on the in-process rate-limit cooldown (0 = none).
    rate_limit_cooldown_seconds: Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000)),
    total_meta_ads: Object.values(matchCounts).reduce((a, b) => a + b, 0),
    match_counts: matchCounts,
    daily_insights: dailyRangeResult.rows[0] || null,
    auto_sync: require('./metaAutoSync').describe(),
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

// Read-only inventory report over the LOCAL meta_ads table (plus the local
// meta_sync_runs log) -- never calls Meta, never writes. Exists to tell a
// genuine historical ad inventory apart from a discovery/pagination bug:
// meta_ads.meta_ad_id is UNIQUE and discovery upserts ON CONFLICT, so the
// stored row count can only ever equal the number of DISTINCT ad ids Meta
// returned; the recent-runs block adds the other half of the check
// (ads_discovered per run vs rows actually inserted/updated -- a repeated
// page would show up as discovered > distinct stored).
async function adInventoryDiagnostics() {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  const [
    totals, byStatus, createdRange, byYear, windows, shell, withInsights, firstSeen, uniqueIdx, runs, hierarchy,
  ] = await Promise.all([
    q(`SELECT count(*)::int AS total_rows, count(DISTINCT meta_ad_id)::int AS distinct_ids FROM meta_ads`),
    q(`SELECT COALESCE(effective_status, '(null)') AS effective_status, count(*)::int AS count
       FROM meta_ads GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT min(created_time) AS oldest, max(created_time) AS newest,
              count(*) FILTER (WHERE created_time IS NULL)::int AS null_created_time,
              count(*) FILTER (WHERE created_time > now())::int AS future_dated
       FROM meta_ads`),
    q(`SELECT COALESCE(EXTRACT(YEAR FROM created_time AT TIME ZONE 'UTC')::int::text, '(null)') AS year, count(*)::int AS count
       FROM meta_ads GROUP BY 1 ORDER BY 1`),
    q(`SELECT count(*) FILTER (WHERE created_time >= now() - interval '30 days')::int AS last_30_days,
              count(*) FILTER (WHERE created_time >= now() - interval '90 days')::int AS last_90_days,
              count(*) FILTER (WHERE created_time >= '2026-01-01T00:00:00Z' AND created_time < '2027-01-01T00:00:00Z')::int AS created_in_2026
       FROM meta_ads`),
    q(`SELECT count(*) FILTER (WHERE ad_name IS NULL)::int AS null_ad_name FROM meta_ads`),
    q(`SELECT count(DISTINCT meta_ad_id)::int AS ads_with_daily_insights FROM meta_ad_insights_daily`),
    q(`SELECT min(first_seen_at) AS earliest, max(first_seen_at) AS latest,
              count(DISTINCT first_seen_at::date)::int AS distinct_first_seen_days FROM meta_ads`),
    q(`SELECT count(*)::int AS n FROM pg_indexes
       WHERE tablename = 'meta_ads' AND indexdef ILIKE 'CREATE UNIQUE INDEX%(meta_ad_id)%'`),
    q(`SELECT id, run_type, range_since, range_until, status, ads_discovered, ads_inserted, ads_updated,
              daily_rows_inserted, daily_rows_updated, started_at, finished_at
       FROM meta_sync_runs ORDER BY started_at DESC LIMIT 5`),
    q(`SELECT count(DISTINCT meta_campaign_id)::int AS distinct_campaigns,
              count(DISTINCT meta_adset_id)::int AS distinct_adsets,
              count(*) FILTER (WHERE meta_ad_id = meta_campaign_id OR meta_ad_id = meta_adset_id)::int AS ad_id_equals_campaign_or_adset_id
       FROM meta_ads`),
  ]);
  const { total_rows: totalRows, distinct_ids: distinctIds } = totals[0];
  return {
    local_only: true,
    total_rows: totalRows,
    distinct_meta_ad_ids: distinctIds,
    duplicate_meta_ad_ids: totalRows - distinctIds,
    unique_index_on_meta_ad_id: uniqueIdx[0].n > 0,
    by_effective_status: byStatus,
    created_time: {
      oldest: createdRange[0].oldest,
      newest: createdRange[0].newest,
      null_created_time: createdRange[0].null_created_time,
      future_dated: createdRange[0].future_dated,
    },
    by_creation_year_utc: byYear,
    created_last_30_days: windows[0].last_30_days,
    created_last_90_days: windows[0].last_90_days,
    created_in_2026: windows[0].created_in_2026,
    rows_with_null_ad_name: shell[0].null_ad_name,
    ads_with_daily_insights: withInsights[0].ads_with_daily_insights,
    first_seen_at: firstSeen[0],
    hierarchy_sanity: hierarchy[0],
    recent_sync_runs: runs,
  };
}

module.exports = {
  startRunExclusive,
  runSync,
  runDefaultSync,
  refreshInventory,
  defaultWindow,
  runBackfill,
  getSyncStatus,
  rederiveConversions,
  conversionAliasTotals,
  adInventoryDiagnostics,
};
