// Automatic RECENT Meta performance sync.
//
// What it does: every few hours it runs the SAME routine performance sync an
// admin can start from Settings -> Meta Sync (metaSync.runSync, Job A) over a
// short rolling window ending today (Australia/Sydney, the account reporting
// timezone). That keeps ranges such as Yesterday / Last 7 Days current without
// anyone clicking.
//
// What it deliberately does NOT do (and the source is checked for it in
// test/metaAutoSync.test.js):
//   - no historical backfill (window is hard-capped at MAX_WINDOW_DAYS);
//   - no full inventory refresh (metaSync.refreshInventory);
//   - no Ad Matching refresh / backlog / catalogue work of any kind;
//   - no Meta write -- runSync only issues Graph API GETs.
//
// Safety properties:
//   - read-only against Meta; writes only meta_ad_insights_daily / meta_ads
//     identity rows / meta_sync_runs through runSync's existing idempotent
//     upserts (so overlapping windows never duplicate rows);
//   - one run at a time: runSync starts every run under a Postgres advisory
//     lock + "no recent running row" check, shared with the manual buttons,
//     so a manual click and a scheduled run (or two instances) can't overlap;
//   - resumable: a failed run is logged as failed, stores nothing it can't
//     stand behind, and is simply retried on a later check after a backoff;
//     a Meta rate-limit cooldown is honoured (runSync fails fast, no call);
//   - runs are recorded as run_type 'default' with no started_by user, which
//     is how they are told apart from manual ones;
//   - META_AUTO_SYNC=off disables the scheduler entirely.
const { pool } = require('../db');
const metaSync = require('./metaSync');
const { configured } = require('./metaAds');
const { ymdInZone, addDays, REPORTING_TIMEZONE } = require('./metaPerformance');

const CHECK_EVERY_MS = 15 * 60 * 1000; // how often the scheduler looks at whether a run is due
const REFRESH_EVERY_HOURS = 3; // a run is due when the last successful one is older than this
const FAILURE_BACKOFF_MINUTES = 30; // after a failed run, wait this long before trying again
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000; // after boot
const NORMAL_WINDOW_DAYS = 3; // today + the 2 days before (same as the manual default)
const SETTLE_WINDOW_DAYS = 7; // once a day, re-pull a week so late attribution settles
const MAX_WINDOW_DAYS = 7; // hard cap: this job can never reach further back than this

function enabled() {
  return String(process.env.META_AUTO_SYNC || 'on').toLowerCase() !== 'off';
}

function windowFor(days, now = new Date()) {
  const until = ymdInZone(now, REPORTING_TIMEZONE);
  const span = Math.min(days, MAX_WINDOW_DAYS);
  return { since: addDays(until, -(span - 1)), until };
}

// Decides (from stored sync history only -- no Meta call) whether a run is due
// and over which window. Pure DB reads; safe to call at any time.
async function planNextRun(now = new Date()) {
  const running = await pool.query(
    `SELECT 1 FROM meta_sync_runs WHERE status = 'running' AND started_at > now() - interval '30 minutes' LIMIT 1`
  );
  if (running.rows.length) return { due: false, reason: 'a sync is already running' };

  const recentFailure = await pool.query(
    `SELECT 1 FROM meta_sync_runs
     WHERE run_type = 'default' AND status = 'failed' AND started_by_user_id IS NULL
       AND started_at > now() - ($1 || ' minutes')::interval
       AND NOT EXISTS (SELECT 1 FROM meta_sync_runs s WHERE s.run_type = 'default' AND s.status = 'success' AND s.finished_at > meta_sync_runs.started_at)
     LIMIT 1`,
    [String(FAILURE_BACKOFF_MINUTES)]
  );
  if (recentFailure.rows.length) return { due: false, reason: 'backing off after a failed automatic run' };

  const fresh = await pool.query(
    `SELECT 1 FROM meta_sync_runs
     WHERE run_type = 'default' AND status = 'success' AND range_until >= $2::date
       AND finished_at > now() - ($1 || ' hours')::interval LIMIT 1`,
    [String(REFRESH_EVERY_HOURS), ymdInZone(now, REPORTING_TIMEZONE)]
  );
  if (fresh.rows.length) return { due: false, reason: 'recent data is already fresh' };

  const settled = await pool.query(
    `SELECT 1 FROM meta_sync_runs
     WHERE run_type = 'default' AND status = 'success' AND (range_until - range_since) >= $1
       AND finished_at > now() - interval '24 hours' LIMIT 1`,
    [SETTLE_WINDOW_DAYS - 1]
  );
  const days = settled.rows.length ? NORMAL_WINDOW_DAYS : SETTLE_WINDOW_DAYS;
  return { due: true, days, ...windowFor(days, now) };
}

let inFlight = false;

// One scheduler tick. Never throws; returns what happened (for logs/tests).
async function runOnce({ now = new Date(), sync = metaSync.runSync } = {}) {
  if (!enabled()) return { ran: false, reason: 'disabled (META_AUTO_SYNC=off)' };
  if (!configured()) return { ran: false, reason: 'Meta is not configured' };
  if (inFlight) return { ran: false, reason: 'a scheduled run is already in progress' };
  inFlight = true;
  try {
    const plan = await planNextRun(now);
    if (!plan.due) return { ran: false, reason: plan.reason };
    // Belt and braces on the hard cap, whatever planNextRun computed.
    const spanDays = Math.round((Date.parse(plan.until) - Date.parse(plan.since)) / 86400000) + 1;
    if (spanDays > MAX_WINDOW_DAYS) return { ran: false, reason: 'window exceeds the automatic-sync cap' };
    const result = await sync({ since: plan.since, until: plan.until, runType: 'default', userId: null });
    return { ran: true, since: plan.since, until: plan.until, daily_rows_seen: result.daily_rows_seen };
  } catch (err) {
    // SYNC_IN_PROGRESS / rate limit / Meta failure: already logged by runSync
    // (or intentionally not started); just retry on a later check.
    return { ran: false, reason: err && err.code === 'SYNC_IN_PROGRESS' ? 'a sync is already running' : `run failed: ${String((err && err.message) || err).replace(/https?:\/\/\S+/g, '[url removed]').slice(0, 200)}` };
  } finally {
    inFlight = false;
  }
}

function startScheduler() {
  if (!enabled()) { console.log('Meta auto-sync: disabled (META_AUTO_SYNC=off)'); return null; }
  if (!configured()) { console.log('Meta auto-sync: not started (Meta is not configured)'); return null; }
  const tick = () => runOnce().then((r) => { if (r.ran) console.log(`Meta auto-sync: synced ${r.since}..${r.until}`); }).catch(() => {});
  const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  const timer = setInterval(tick, CHECK_EVERY_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  console.log(`Meta auto-sync: on -- checks every ${CHECK_EVERY_MS / 60000} min, refreshes the last ${NORMAL_WINDOW_DAYS} days every ${REFRESH_EVERY_HOURS} h (last ${SETTLE_WINDOW_DAYS} days once a day)`);
  return () => { clearTimeout(first); clearInterval(timer); };
}

function describe() {
  return {
    enabled: enabled() && configured(),
    check_every_minutes: CHECK_EVERY_MS / 60000,
    refresh_every_hours: REFRESH_EVERY_HOURS,
    window_days: NORMAL_WINDOW_DAYS,
    settle_window_days: SETTLE_WINDOW_DAYS,
  };
}

module.exports = {
  enabled, windowFor, planNextRun, runOnce, startScheduler, describe,
  NORMAL_WINDOW_DAYS, SETTLE_WINDOW_DAYS, MAX_WINDOW_DAYS, REFRESH_EVERY_HOURS, CHECK_EVERY_MS,
};
