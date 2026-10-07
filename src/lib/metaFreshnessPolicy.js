// How long each kind of Meta Performance data may be reused before it is considered stale. Pure; shared by the
// Reach cache (metaReachStore) and the freshness/refresh logic (metaFreshness) so the "stale" flag and the actual
// refresh decisions can never disagree. today / range.until are 'YYYY-MM-DD' in the reporting timezone.
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const MAX_REFRESH_DAYS = 7; // hard cap: an automatic refresh never reaches further back than this (no backfill)
const RECENT_DAYS = 3; // periods ending within this many days of today are still settling

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

// Additive per-ad metrics (stored Insights sync): null = never refreshed automatically.
function additiveTtlMs(range, today) {
  if (range.until >= today) return 15 * MIN;
  if (range.until >= addDays(today, -RECENT_DAYS)) return 3 * HOUR;
  return null;
}
// Exact range Reach / Frequency.
function reachTtlMs(range, today) {
  if (range.until >= today) return 30 * MIN;
  if (range.until >= addDays(today, -RECENT_DAYS)) return 6 * HOUR;
  return 7 * 24 * HOUR;
}
// The part of a range an automatic refresh may touch: the range clipped to [today-6, today]; null if it is all older.
function refreshableWindow(range, today) {
  const floor = addDays(today, -(MAX_REFRESH_DAYS - 1));
  const since = range.since < floor ? floor : range.since;
  const until = range.until > today ? today : range.until;
  return since <= until ? { since, until } : null;
}

module.exports = { additiveTtlMs, reachTtlMs, refreshableWindow, addDays, MAX_REFRESH_DAYS, RECENT_DAYS, MIN, HOUR };
