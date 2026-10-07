// Range-level Reach / Frequency: DATABASE-ONLY reads (no network, no Meta import).
//
// Reach is unique people, so it can't be summed across days or ads. Exact
// period values are pulled from Meta on demand (src/lib/metaRangeReach.js,
// admin click) and cached per exact range in meta_reach_pulls /
// meta_ad_range_reach. This file only reads that cache, so the Performance page
// still never costs a Meta call.
//
//   single-day range -> per-ad Reach/Frequency are exact from the stored daily
//                       rows (source 'stored_daily'); the ACCOUNT figure still
//                       needs a pull (ads overlap, so ad rows can't be summed)
//   multi-day range  -> per-ad and account values come from the latest
//                       COMPLETED pull for exactly that range (source 'meta_range')
const { pool } = require('../db');

const policy = require('./metaFreshnessPolicy');
const FRESH_MS_RECENT = 6 * 60 * 60 * 1000; // (kept for importers) -- the live rule is metaFreshnessPolicy.reachTtlMs
const FRESH_MS_PAST = 7 * 24 * 60 * 60 * 1000;
const RUNNING_STALE_MS = 15 * 60 * 1000; // a 'running' row this old is a crashed pull, not a live one

function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
const num = (v) => (v === null || v === undefined ? null : Number(v));

// today: 'YYYY-MM-DD' in the reporting timezone (the caller knows it).
function freshnessMs(range, today) {
  return policy.reachTtlMs(range, today);
}

// Status of the cache for one exact range. Never touches Meta.
async function getStatus(range, today, { db = pool, now = Date.now() } = {}) {
  const single = range.since === range.until;
  const [latest, done] = await Promise.all([
    db.query('SELECT * FROM meta_reach_pulls WHERE since_date = $1 AND until_date = $2 ORDER BY id DESC LIMIT 1', [range.since, range.until]),
    db.query("SELECT * FROM meta_reach_pulls WHERE since_date = $1 AND until_date = $2 AND state = 'completed' ORDER BY id DESC LIMIT 1", [range.since, range.until]),
  ]);
  const l = latest.rows[0] || null;
  const c = done.rows[0] || null;
  const running = l && l.state === 'running' && now - new Date(l.started_at).getTime() < RUNNING_STALE_MS;
  const fresh = c ? now - new Date(c.finished_at).getTime() < freshnessMs(range, today) : false;
  let state = 'not_loaded';
  if (running) state = 'loading';
  else if (c) state = 'ready';
  else if (l && l.state === 'failed') state = 'failed';
  const lastFailed = l && l.state === 'failed' && (!c || l.id > c.id) ? l : null;
  return {
    range,
    state,
    source: 'meta_range',
    single_day: single,
    includes_today: range.until >= today,
    pull_id: c ? c.id : null,
    pulled_at: c ? new Date(c.finished_at).toISOString() : null,
    stale: !!c && !fresh,
    ads_in_pull: c ? c.ads_total : null,
    account: c ? { reach: num(c.account_reach), frequency: num(c.account_frequency), impressions: num(c.account_impressions) } : null,
    // a failed refresh after a successful pull keeps the old numbers visible but says so
    last_error: lastFailed ? { code: lastFailed.error_code, message: lastFailed.error_message, retry_after_seconds: lastFailed.retry_after_seconds } : null,
    // per-ad values are available when this is true (single-day ranges need no pull)
    ad_values: single ? 'stored_daily' : (c ? 'meta_range' : null),
  };
}

// Headline Reach / Frequency for the summary area.
function summaryFrom(status) {
  const a = status.account;
  return {
    available: !!a,
    state: status.state,
    reach: a ? a.reach : null,
    frequency: a ? a.frequency : null,
    pulled_at: status.pulled_at,
    stale: status.stale,
    includes_today: status.includes_today,
    last_error: status.last_error,
    source: 'meta_range',
    reason: a ? null : (status.state === 'loading' ? 'Loading from Meta…'
      : status.state === 'failed' ? ((status.last_error && status.last_error.message) || 'The last attempt to load this from Meta failed.')
        : 'Reach and Frequency are not additive across days or ads, so the exact figure for this period is loaded from Meta on request.'),
  };
}

module.exports = { getStatus, summaryFrom, addDaysYmd, freshnessMs, FRESH_MS_RECENT, FRESH_MS_PAST, RUNNING_STALE_MS };
