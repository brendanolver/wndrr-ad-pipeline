// Bounded Meta "who delivered since the cutoff?" check -- the evidence behind the Pre-2026 archive when stored Insights do
// not reach back far enough on their own (see metaCreativeArchive.js).
//
// Strictly read-only and EXPLICIT: only an admin pressing the button starts it (POST /api/meta-ad-matching/archive/pull);
// nothing schedules it and a page view never reaches here. Exactly this request, no more:
//
//   GET <ad account>/insights
//       level      = ad
//       fields     = ad_id,spend,impressions            (three fields; no breakdowns, no actions)
//       time_range = {"since":"<cutoff>","until":"<yesterday>"}      (ONE aggregate row per ad that delivered, NO time_increment)
//       limit      = 500                                 (paged with Meta's cursor)
//
// Cost: one call per 500 ads that delivered in the period (so a few calls for a typical account). If Meta answers "reduce
// the amount of data" it is retried per calendar month (still the same three fields). Results are stored in ONE
// transaction only when every page was read to the end -- a partial / failed pull never becomes evidence. One pull at a
// time; a recent completed pull is reused instead of asking Meta again. Nothing here writes to meta_ads, the daily Insights
// table, classifications, matching state or any snapshot.
const { pool } = require('../db');
const metaAds = require('./metaAds');
const archive = require('./metaCreativeArchive');
const { HttpError, ymdInZone, addDays } = require('./metaPerformance');

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const REUSE_WITHIN_MS = 6 * 60 * 60 * 1000;
let activeRun = null;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Exactly what the pull would ask Meta (shown to the admin before they confirm). Pure + a count of stored ads for context.
function describeRequest(today, cutoff = archive.ARCHIVE_CUTOFF) {
  const until = addDays(today, -1);
  return {
    method: 'GET',
    path: '<ad account>/insights',
    params: { level: 'ad', fields: 'ad_id,spend,impressions', time_range: { since: cutoff, until }, limit: 500 },
    read_only: true,
    returns: 'one aggregate row per ad that delivered in the period (no daily breakdown)',
    calls: 'one per 500 ads that delivered in the period (typically a handful); retried per calendar month only if Meta asks to reduce the data',
    writes_to_meta: false,
    stores: 'the list of ad ids that delivered, in meta_ad_delivery_since; nothing in ads, Insights, matching or classifications changes',
    since: cutoff,
    until,
  };
}

async function getStatus() {
  const r = await pool.query(
    `SELECT id, state, to_char(since_date, 'YYYY-MM-DD') AS since, to_char(until_date, 'YYYY-MM-DD') AS until, ads_with_delivery, calls, error_code, error_message, retry_after_seconds, started_at, finished_at
       FROM meta_activity_pulls ORDER BY id DESC LIMIT 1`
  );
  return r.rows[0] || null;
}

async function startPull({ userId = null, force = false } = {}, deps = {}) {
  const configured = deps.configured ? deps.configured() : metaAds.configured();
  if (!configured) throw new HttpError(409, 'Meta is not configured in this environment, so the activity check cannot run.');
  const now = deps.now || new Date();
  const today = ymdInZone(now);
  const range = { since: archive.ARCHIVE_CUTOFF, until: addDays(today, -1) };
  const last = await getStatus();
  if (last && last.state === 'running' && Date.now() - new Date(last.started_at).getTime() < RUN_TIMEOUT_MS + 60 * 1000) return { status: last, started: false, reason: 'already running' };
  if (!force && last && last.state === 'completed' && last.since === range.since && Date.now() - new Date(last.finished_at).getTime() < REUSE_WITHIN_MS) {
    return { status: last, started: false, reason: 'a recent check is still fresh (no Meta call made)' };
  }
  if (activeRun) throw new HttpError(409, 'An activity check is already running.');
  const ins = await pool.query("INSERT INTO meta_activity_pulls (since_date, until_date, state, requested_by_user_id) VALUES ($1,$2,'running',$3) RETURNING id", [range.since, range.until, userId]);
  const pullId = ins.rows[0].id;
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(async () => {
      await pool.query("UPDATE meta_activity_pulls SET state='failed', finished_at=now(), error_code='timeout', error_message='Meta did not respond in time. Nothing was stored; try again.' WHERE id=$1 AND state='running'", [pullId]).catch(() => {});
      resolve();
    }, deps.timeoutMs || RUN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
  const run = Promise.race([runPull(pullId, range, deps), watchdog]).finally(() => { clearTimeout(timer); activeRun = null; archive.resetProofMemo(); });
  activeRun = run;
  if (deps.wait) await run;
  return { status: await getStatus(), started: true, request: describeRequest(today) };
}

const MONTH_END = (ymd) => { const [y, m] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m, 0)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`; };
function monthChunks(since, until) {
  const out = [];
  let a = since;
  while (a <= until) { const e = MONTH_END(a); const b = e < until ? e : until; out.push({ since: a, until: b }); a = addDays(b, 1); }
  return out;
}
const isTooMuchData = (err) => !!(err && /reduce the amount of data|too much data|request.*too large/i.test(String(err.message || '')));

async function runPull(pullId, range, deps = {}) {
  const getPages = deps.metaGetAllPages || metaAds.metaGetAllPages;
  const accountPath = deps.accountPath || metaAds.accountPath;
  let calls = 0;
  try {
    const rows = new Map();
    const pullRange = async (r) => {
      const paging = await getPages(`${accountPath()}/insights`, {
        level: 'ad', fields: 'ad_id,spend,impressions', time_range: JSON.stringify({ since: r.since, until: r.until }), limit: '500',
      }, async (page) => {
        for (const x of page) {
          if (!x || !x.ad_id) continue;
          const cur = rows.get(String(x.ad_id)) || { spend: 0, impressions: 0 };
          cur.spend += num(x.spend); cur.impressions += Math.round(num(x.impressions));
          rows.set(String(x.ad_id), cur);
        }
      });
      calls += paging.pages || 0;
      if (paging.stoppedReason !== 'end') throw new Error(`Meta pagination stopped early (${paging.stoppedReason}); nothing was stored.`);
    };
    try { await pullRange(range); } catch (err) {
      if (!isTooMuchData(err)) throw err;
      rows.clear(); // start over month by month so the evidence is never a mixture
      for (const chunk of monthChunks(range.since, range.until)) await pullRange(chunk);
    }
    // only ads that actually delivered count as evidence of delivery
    const ids = [...rows.keys()].filter((i) => rows.get(i).spend > 0 || rows.get(i).impressions > 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (ids.length) {
        await client.query(
          `INSERT INTO meta_ad_delivery_since (pull_id, meta_ad_id, spend, impressions)
           SELECT $1::int, * FROM unnest($2::text[], $3::numeric[], $4::bigint[])`,
          [pullId, ids, ids.map((i) => rows.get(i).spend), ids.map((i) => rows.get(i).impressions)]
        );
      }
      await client.query("UPDATE meta_activity_pulls SET state='completed', finished_at=now(), ads_with_delivery=$2, calls=$3 WHERE id=$1", [pullId, ids.length, calls]);
      // the new pull supersedes older ones for the same period (their rows cascade away)
      await client.query('DELETE FROM meta_activity_pulls WHERE since_date = $1 AND id <> $2', [range.since, pullId]);
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
    const message = safe ? err.message : (err && /pagination/.test(err.message) ? err.message : 'The Meta request failed. Nothing was stored; try again later.');
    await pool.query("UPDATE meta_activity_pulls SET state='failed', finished_at=now(), calls=$4, error_code=$2, error_message=$3, retry_after_seconds=$5 WHERE id=$1",
      [pullId, code, String(message).slice(0, 300), calls, (err && err.retryAfterSeconds) || null]).catch(() => {});
  }
}

module.exports = { describeRequest, getStatus, startPull, runPull, monthChunks, isTooMuchData };
