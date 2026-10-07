// Range-level Reach / Frequency pull -- the ONLY Meta call in the Reach feature.
//
// Strictly read-only: GET <account>/insights (level=account, then level=ad)
// with the selected time_range and NO time_increment, so Meta returns
// de-duplicated Reach and Frequency for exactly that period. Triggered only by
// an explicit admin click (POST /api/meta-performance/reach/load); a page view
// reads the cache (metaReachStore.js) and never reaches here.
//
// Safety:
//   * results are written in ONE transaction only when the whole pull
//     succeeded -- a partial/truncated pull never becomes "ready";
//   * one pull at a time (rate-limit friendly); a repeat click while one is
//     running, or while the cache is still fresh, makes no Meta call;
//   * errors are reduced to a short, token- and URL-free message
//     (MetaApiError messages are safe by construction; anything else is generic);
//   * nothing here writes to meta_ads / meta_ad_insights_daily or touches
//     matching, classifications or snapshots.
const { pool } = require('../db');
const metaAds = require('./metaAds');
const store = require('./metaReachStore');
const { HttpError, ymdInZone } = require('./metaPerformance');

const RUN_TIMEOUT_MS = 10 * 60 * 1000; // a Meta call that never answers must not block the feature forever
let activeRun = null; // in-process guard; the DB 'running' row is the cross-restart view

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
const toFreq = (v) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

async function getStatus(range, now = new Date()) {
  return store.getStatus(range, ymdInZone(now), { now: now.getTime() });
}

// Start (or reuse) a pull for one exact range. Returns the status immediately; the
// Meta calls run in the background. deps.wait awaits completion (tests).
async function startPull(range, { userId = null, force = false } = {}, deps = {}) {
  const configured = deps.configured ? deps.configured() : metaAds.configured();
  if (!configured) throw new HttpError(409, 'Meta is not configured in this environment, so Reach and Frequency cannot be loaded.');
  const now = deps.now || new Date();
  const today = ymdInZone(now);
  if (range.since > today) throw new HttpError(400, 'That period is entirely in the future.');

  const status = await store.getStatus(range, today, { now: now.getTime() });
  if (status.state === 'loading') return status;
  if (!force && status.state === 'ready' && !status.stale) return status; // fresh cache: no Meta call
  const anyRunning = await pool.query("SELECT 1 FROM meta_reach_pulls WHERE state = 'running' AND started_at > now() - interval '15 minutes' LIMIT 1");
  if (activeRun || anyRunning.rows.length) throw new HttpError(409, 'Another Reach & Frequency load is already running. Try again in a minute.');

  const ins = await pool.query(
    "INSERT INTO meta_reach_pulls (since_date, until_date, state, requested_by_user_id) VALUES ($1, $2, 'running', $3) RETURNING id",
    [range.since, range.until, userId]
  );
  const pullId = ins.rows[0].id;
  // Watchdog: if Meta never answers, mark the pull failed and release the guard (a late success still wins).
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(async () => {
      await pool.query(
        "UPDATE meta_reach_pulls SET state = 'failed', finished_at = now(), error_code = 'timeout', error_message = 'Meta did not respond in time. Existing data is safe; try again.' WHERE id = $1 AND state = 'running'",
        [pullId]
      ).catch(() => {});
      resolve();
    }, deps.timeoutMs || RUN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
  const run = Promise.race([runPull(pullId, range, today, deps), watchdog]).finally(() => { clearTimeout(timer); activeRun = null; });
  activeRun = run;
  if (deps.wait) await run;
  return store.getStatus(range, today, { now: now.getTime() });
}

async function runPull(pullId, range, today, deps = {}) {
  const getOne = deps.metaGet || metaAds.metaGet;
  const getPages = deps.metaGetAllPages || metaAds.metaGetAllPages;
  const accountPath = deps.accountPath || metaAds.accountPath;
  try {
    // Meta has no data for days that haven't happened: clamp the pull, keep the cache key as requested.
    const until = range.until > today ? today : range.until;
    const timeRange = JSON.stringify({ since: range.since, until });
    const acct = await getOne(`${accountPath()}/insights`, { level: 'account', fields: 'reach,frequency,impressions', time_range: timeRange });
    if (acct.status !== 200) throw metaAds.buildMetaApiError(acct, 'Meta account Reach request');
    const arow = ((acct.data && acct.data.data) || [])[0] || null;

    const rows = new Map();
    const paging = await getPages(`${accountPath()}/insights`, {
      level: 'ad', fields: 'ad_id,reach,frequency,impressions', time_range: timeRange, limit: '500',
    }, async (page) => {
      for (const r of page) {
        if (r && r.ad_id) rows.set(String(r.ad_id), { reach: Math.round(num(r.reach)), frequency: toFreq(r.frequency), impressions: Math.round(num(r.impressions)) });
      }
    });
    if (paging.stoppedReason !== 'end') throw new Error(`Meta pagination stopped early (${paging.stoppedReason}); nothing was stored.`);

    const ids = [...rows.keys()];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (ids.length) {
        await client.query(
          `INSERT INTO meta_ad_range_reach (pull_id, meta_ad_id, reach, frequency, impressions)
           SELECT $1::int, * FROM unnest($2::text[], $3::bigint[], $4::numeric[], $5::bigint[])`,
          [pullId, ids, ids.map((i) => rows.get(i).reach), ids.map((i) => rows.get(i).frequency), ids.map((i) => rows.get(i).impressions)]
        );
      }
      await client.query(
        `UPDATE meta_reach_pulls SET state = 'completed', finished_at = now(), ads_total = $2,
                account_reach = $3, account_frequency = $4, account_impressions = $5 WHERE id = $1`,
        [pullId, ids.length, arow ? Math.round(num(arow.reach)) : null, arow ? toFreq(arow.frequency) : null, arow ? Math.round(num(arow.impressions)) : null]
      );
      // the new pull supersedes older ones for the same range (their rows cascade away)
      await client.query('DELETE FROM meta_reach_pulls WHERE since_date = $1 AND until_date = $2 AND id <> $3', [range.since, range.until, pullId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    const safe = err && err.safe;
    const code = err && err.rateLimited ? 'rate_limited' : safe ? 'meta_error' : 'error';
    const message = safe ? err.message : (err && /pagination/.test(err.message) ? err.message : 'The Meta request failed. Existing data is safe; try again later.');
    await pool.query(
      "UPDATE meta_reach_pulls SET state = 'failed', finished_at = now(), error_code = $2, error_message = $3, retry_after_seconds = $4 WHERE id = $1",
      [pullId, code, String(message).slice(0, 300), (err && err.retryAfterSeconds) || null]
    ).catch(() => {});
  }
}

module.exports = { getStatus, startPull, runPull };
