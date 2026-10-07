// Automatic freshness for Meta Performance.
//
// The page shows what is stored/cached IMMEDIATELY, asks here whether the selected period is stale, and (when allowed)
// refreshes only what is stale, in the background; the page polls and re-renders. Nothing here is real-time: Meta's own
// numbers settle over a day or more, so how often to look again depends on how recent the period is.
//
//   what                        today / includes today     ended in the last 3 days     older
//   additive metrics (spend,    15 min                     3 h                          never automatic
//   purchases, ATC, CTR, value, (stored Insights sync)     (attribution still settling)  (a gap = a manual backfill,
//   per-ad table)                                                                        never an automatic one)
//   exact Reach / Frequency     30 min                     6 h                          7 days
//   campaign names              6 h (any period)
//
// Two kinds of data, two mechanisms -- never mixed:
//   * additive per-ad metrics come from the stored daily Insights sync (metaSync.runSync), limited to the last 7 days;
//   * Reach / Frequency are unique-people figures that are pulled from Meta for the EXACT range (metaRangeReach) and are
//     never summed from daily rows.
//
// The master switch: automatic (page-triggered) refreshes are allowed only when META_AUTO_SYNC is not 'off' and Meta is
// configured -- the SAME switch that governs the background scheduler (metaAutoSync.enabled()). With it off, the page shows
// stored data, says how old it is, and the manual "Refresh now" button (force) still works. This module never starts the
// scheduler and never runs a backfill or any matching work.
const { pool } = require('../db');
const metaAds = require('./metaAds');
const metaSync = require('./metaSync');
const reachLib = require('./metaRangeReach');
const reachStore = require('./metaReachStore');
const campaigns = require('./metaCampaigns');
const autoSync = require('./metaAutoSync');
const { addDays, listDates, ymdInZone } = require('./metaPerformance');

const policy = require('./metaFreshnessPolicy');
const { additiveTtlMs, reachTtlMs, refreshableWindow, MAX_REFRESH_DAYS, MIN, HOUR } = policy;
const CAMPAIGN_TTL_MS = 6 * HOUR;
const AUTO_MIN_INTERVAL_MS = 2 * MIN; // between automatic attempts at the same thing
const FAILURE_BACKOFF_MS = 5 * MIN;
const FORCE_MIN_INTERVAL_MS = 20 * 1000;

const state = { inflight: new Map(), attempts: new Map(), failures: new Map() };
function resetForTests() { state.inflight.clear(); state.attempts.clear(); state.failures.clear(); }

function autoEnabled(deps = {}) {
  const configured = deps.configured ? deps.configured() : metaAds.configured();
  const on = deps.autoEnabled ? deps.autoEnabled() : autoSync.enabled();
  return !!(configured && on);
}

// When did the stored Insights last cover every recent day of this range? (min over days of the newest covering run.)
async function additiveStatus(range, today, now, db = pool) {
  const ttl = additiveTtlMs(range, today);
  const w = refreshableWindow(range, today);
  const base = { ttl_ms: ttl, window: w, last_synced_at: null, stale: false, needs_backfill: false };
  const all = await db.query(
    `SELECT to_char(range_since, 'YYYY-MM-DD') AS since, to_char(range_until, 'YYYY-MM-DD') AS until, finished_at
       FROM meta_sync_runs WHERE status = 'success' AND run_type IN ('default', 'backfill') AND finished_at IS NOT NULL AND range_until >= $1 AND range_since <= $2`,
    [range.since, range.until]
  );
  // days older than the refreshable window that nothing has synced: only a manual backfill can fill them
  const olderEnd = w ? addDays(w.since, -1) : range.until;
  const olderDays = range.since <= olderEnd ? listDates(range.since, olderEnd) : [];
  base.needs_backfill = olderDays.some((d) => !all.rows.some((r) => r.since <= d && d <= r.until));
  if (!w) return base;
  let oldest = null;
  let uncovered = false;
  for (const day of listDates(w.since, w.until)) {
    const covering = all.rows.filter((r) => r.since <= day && day <= r.until);
    if (!covering.length) { uncovered = true; continue; }
    const newest = Math.max(...covering.map((r) => new Date(r.finished_at).getTime()));
    // a day that was last synced before it finished is still changing (the "in progress" case) -- handled by ttl for recent days
    oldest = oldest === null ? newest : Math.min(oldest, newest);
  }
  base.last_synced_at = oldest === null ? null : new Date(oldest).toISOString();
  base.stale = ttl === null ? uncovered : (uncovered || oldest === null || now - oldest > ttl);
  return base;
}

async function getFreshness(range, { now = Date.now(), db = pool } = {}, deps = {}) {
  const today = ymdInZone(new Date(now));
  const [additive, reach, camp] = await Promise.all([
    additiveStatus(range, today, now, db),
    reachStore.getStatus(range, today, { now, db }),
    campaigns.lastFetchedAt(db),
  ]);
  const rTtl = reachTtlMs(range, today);
  const reachFresh = reach.pulled_at ? now - new Date(reach.pulled_at).getTime() < rTtl : false;
  const campStale = !camp.at || now - camp.at.getTime() > CAMPAIGN_TTL_MS;
  const key = (t) => `${t}:${range.since}:${range.until}`;
  const running = {
    sync: state.inflight.has(`sync:${additive.window ? additive.window.since + ':' + additive.window.until : 'none'}`),
    reach: reach.state === 'loading',
    campaigns: state.inflight.has('campaigns'),
  };
  const enabled = autoEnabled(deps);
  return {
    range,
    now: new Date(now).toISOString(),
    includes_today: range.until >= today,
    today_in_progress: range.until >= today,
    auto_enabled: enabled,
    auto_disabled_reason: enabled ? null : (!(deps.configured ? deps.configured() : metaAds.configured()) ? 'Meta is not configured here.' : 'Automatic Meta refresh is switched off on this server (META_AUTO_SYNC=off). Showing stored data; use "Refresh now" to update it.'),
    additive: { ...additive, ttl_minutes: additive.ttl_ms === null ? null : Math.round(additive.ttl_ms / MIN) },
    reach: { state: reach.state, pulled_at: reach.pulled_at, stale: reach.state === 'ready' ? !reachFresh : false, ttl_minutes: Math.round(rTtl / MIN), last_error: reach.last_error },
    campaigns: { fetched_at: camp.at ? camp.at.toISOString() : null, count: camp.count, stale: campStale, ttl_minutes: Math.round(CAMPAIGN_TTL_MS / MIN) },
    refreshing: running,
    is_refreshing: running.sync || running.reach || running.campaigns,
    needs_refresh: { additive: additive.stale && !!additive.window, reach: reach.state !== 'loading' && (reach.state !== 'ready' || !reachFresh), campaigns: campStale },
    attempt_keys: { sync: key('sync'), reach: key('reach') },
  };
}

function throttled(taskKey, force, now) {
  const last = state.attempts.get(taskKey) || 0;
  const min = force ? FORCE_MIN_INTERVAL_MS : AUTO_MIN_INTERVAL_MS;
  if (now - last < min) return 'recently attempted';
  const failedAt = state.failures.get(taskKey) || 0;
  if (!force && now - failedAt < FAILURE_BACKOFF_MS) return 'backing off after a failed attempt';
  return null;
}

// Starts whatever is stale (or everything, when force). Returns at once; the work runs in the background.
// auto=true -> a page-triggered automatic refresh (needs the master switch ON); force=true -> the manual button.
async function startRefresh(range, { userId = null, auto = false, force = false } = {}, deps = {}) {
  const now = deps.now || Date.now();
  const today = ymdInZone(new Date(now));
  if (range.since > today) return { started: [], skipped: { all: 'that period is entirely in the future' } };
  if (auto && !force && !autoEnabled(deps)) return { started: [], skipped: { all: 'automatic refresh is switched off' }, auto_enabled: false };
  const configured = deps.configured ? deps.configured() : metaAds.configured();
  if (!configured) return { started: [], skipped: { all: 'Meta is not configured here' } };

  const fresh = await getFreshness(range, { now, db: deps.db }, deps);
  const started = [];
  const skipped = {};
  const waits = [];
  const runSync = deps.runSync || metaSync.runSync;
  const startPull = deps.startPull || reachLib.startPull;
  const refreshCampaigns = deps.refreshCampaigns || campaigns.refreshCampaigns;
  const track = (name, promise, taskKey) => {
    state.attempts.set(taskKey, now);
    state.inflight.set(name, promise);
    const done = promise.then(() => { state.failures.delete(taskKey); }, () => { state.failures.set(taskKey, Date.now()); }).finally(() => { state.inflight.delete(name); });
    waits.push(done);
    return done;
  };

  // 1) additive metrics: the stored Insights sync, clipped to the last 7 days
  const w = fresh.additive.window;
  if (w && (force || fresh.needs_refresh.additive)) {
    const name = `sync:${w.since}:${w.until}`;
    const taskKey = `sync:${range.since}:${range.until}`;
    const why = state.inflight.has(name) ? 'already running' : throttled(taskKey, force, now);
    if (why) skipped.additive = why;
    else {
      track(name, Promise.resolve().then(() => runSync({ since: w.since, until: w.until, runType: 'default', userId })), taskKey);
      started.push('additive');
    }
  } else if (!w) skipped.additive = 'older period: stored data only (a backfill is a manual action)';
  else skipped.additive = 'fresh';

  // 2) exact range Reach / Frequency (its own pull; never summed from daily rows)
  if (force || fresh.needs_refresh.reach) {
    const taskKey = `reach:${range.since}:${range.until}`;
    const why = fresh.refreshing.reach ? 'already running' : throttled(taskKey, force, now);
    if (why) skipped.reach = why;
    else {
      track(`reach:${range.since}:${range.until}`, Promise.resolve().then(() => startPull(range, { userId, force: !!force }, deps.reachDeps || {})), taskKey);
      started.push('reach');
    }
  } else skipped.reach = 'fresh';

  // 3) campaign names: part of runSync; when no sync is running, a single read of the campaign list
  if (!started.includes('additive') && (force || fresh.needs_refresh.campaigns)) {
    const taskKey = 'campaigns';
    const why = state.inflight.has('campaigns') ? 'already running' : throttled(taskKey, force, now);
    if (why) skipped.campaigns = why;
    else { track('campaigns', Promise.resolve().then(() => refreshCampaigns()), taskKey); started.push('campaigns'); }
  } else if (!started.includes('additive')) skipped.campaigns = 'fresh';

  if (deps.wait) await Promise.all(waits);
  return { started, skipped, auto_enabled: autoEnabled(deps) };
}

module.exports = { getFreshness, startRefresh, additiveTtlMs, reachTtlMs, refreshableWindow, autoEnabled, resetForTests, additiveStatus, MAX_REFRESH_DAYS, CAMPAIGN_TTL_MS, AUTO_MIN_INTERVAL_MS };
