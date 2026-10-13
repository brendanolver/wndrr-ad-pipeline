// Meta Performance V1 -- read-only reporting over the LOCAL Meta tables
// (meta_ads, meta_ad_insights_daily, meta_sync_runs, meta_account_settings).
//
// Nothing in this file imports metaAds.js or touches the network: the page
// must keep working from stored data even if Meta is unreachable, and a
// page view must never cost (or leak) a Meta call.
//
// Verified WNDRR conversion definitions (reconciled against Ads Manager for
// 2-4 Oct 2026): purchases = omni_purchase, add to cart = omni_add_to_cart,
// purchase value = omni_purchase action value. Those are already extracted
// into meta_ad_insights_daily.purchases / add_to_cart / purchase_value at
// sync time (see metaReportingConfig.js), so this layer only SUMS them.
// Attribution (7d_click + 1d_view) is still PROVISIONAL.
//
// ── Aggregation rules ───────────────────────────────────────────────────
//  - Additive columns (spend, purchases, purchase_value, add_to_cart,
//    outbound_clicks, impressions) are summed over the selected dates.
//  - Every ratio is recomputed from those sums, never averaged:
//      CPA          = SUM(spend) / SUM(purchases)
//      Cost per ATC = SUM(spend) / SUM(add_to_cart)
//      Outbound CTR = SUM(outbound_clicks) / SUM(impressions) * 100
//    A zero denominator yields null (shown as an em dash), never Infinity/NaN.
//
// ── Reach / Frequency: NEVER summed ─────────────────────────────────────
// Reach is a unique-people count, so it is NOT additive across days or ads
// (the same person reached on Monday and Tuesday is one person, not two),
// and Frequency = impressions / reach inherits the problem. The stored
// daily reach/frequency columns are correct per ad per DAY only; summing or
// averaging them over a range would give a wrong number.
//   * a single-day range: per-ad values are exact from the stored daily rows;
//   * any other range: exact values are pulled from Meta ON DEMAND for that
//     exact range (src/lib/metaRangeReach.js, read-only, admin click) and
//     cached (meta_reach_pulls / meta_ad_range_reach); this file only reads
//     that cache (metaReachStore.js), so a page view never costs a Meta call.
// Until a pull exists the value is an explicit null with a status, never a guess.
//
// ── Thumbstop / Hold Rate: deliberately NOT defined ─────────────────────
// Lucy's Ads Manager Thumbstop is a custom metric whose exact formula has
// not been confirmed, and Hold Rate is undefined. Neither is derived,
// guessed or displayed here until the formula is confirmed. The raw video
// columns (video_plays, thruplays, video_p25 ...) remain stored untouched.
const { pool } = require('../db');
const reachStore = require('./metaReachStore'); // DB-only reads of the Reach/Frequency cache (no network)
const funnelHealth = require('./metaFunnelHealth'); // confirmed WNDRR benchmarks only
const dpaLib = require('./metaDpa'); // Dynamic Product Ads: excluded from creative performance by default

// The account reporting timezone. Insight dates in meta_ad_insights_daily
// are calendar days in the Meta ad account's own timezone, so every
// "today / yesterday / this week" decision is made in that zone -- never
// in the server's (UTC) or the browser's.
const REPORTING_TIMEZONE = 'Australia/Sydney';

const PRESETS = [
  'today', 'yesterday', 'last_3', 'last_4', 'last_7', 'last_14', 'last_30',
  'this_week', 'last_week', 'this_month', 'custom',
  // added with the date-range picker (Batch 14): resolved here, in Sydney time, like every other preset
  'last_90', 'last_month', 'ytd', 'last_365',
];
const DEFAULT_PRESET = 'last_7';
const PRESET_LABELS = {
  today: 'Today', yesterday: 'Yesterday', last_3: 'Last 3 Days', last_4: 'Last 4 Days', last_7: 'Last 7 Days', last_14: 'Last 14 Days',
  last_30: 'Last 30 Days', this_week: 'This Week', last_week: 'Last Week',
  this_month: 'This Month', custom: 'Custom',
  last_90: 'Last 90 Days', last_month: 'Last Month', ytd: 'Year to Date', last_365: 'Last 365 Days',
};
const MAX_CUSTOM_DAYS = 366;

// Placeholder for exact range-level Reach/Frequency (NOT built in V1).
// Returned verbatim by the summary endpoint so the front end already has a
// stable place to read it from once an approved implementation exists.
const REACH_FREQUENCY = {
  available: false,
  reach: null,
  frequency: null,
  reason: 'Reach and Frequency are not additive across days or ads. Exact figures need a range-level Meta Insights pull, which is not part of V1.',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Date helpers (calendar math on 'YYYY-MM-DD' strings, UTC-safe) ──────
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtYmd(date) {
  return date.toISOString().slice(0, 10);
}

function isValidYmd(s) {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  return fmtYmd(parseYmd(s)) === s; // rejects 2026-02-31 style dates
}

function addDays(ymd, n) {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtYmd(d);
}

function daysBetweenInclusive(since, until) {
  return Math.round((parseYmd(until) - parseYmd(since)) / 86400000) + 1;
}

function listDates(since, until) {
  const out = [];
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d);
  return out;
}

// Calendar date "now" in the given IANA zone.
function ymdInZone(date, tz = REPORTING_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// UTC instant at which calendar day `ymd` begins in `tz` (DST-aware: Sydney
// moves clocks at 2am, never at midnight, so a day always starts at 00:00).
function zonedDayStartUtc(ymd, tz = REPORTING_TIMEZONE) {
  const offsetAt = (instant) => {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant);
    const g = (t) => Number(f.find((p) => p.type === t).value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
  };
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetAt(new Date(guess));
  return new Date(guess - offsetAt(new Date(first)));
}

function mondayOf(ymd) {
  const dow = parseYmd(ymd).getUTCDay(); // 0 = Sun
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

function monthStart(ymd) {
  return `${ymd.slice(0, 7)}-01`;
}

function monthEnd(ymd) {
  const d = parseYmd(monthStart(ymd));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return fmtYmd(d);
}

// ── Preset resolution ───────────────────────────────────────────────────
// "Last N Days" = the N COMPLETE days ending yesterday (Ads Manager's own
// convention, which is what the figures were reconciled against); Today /
// This Week / This Month are period-to-date and include today (in
// progress, so the freshness logic below flags them as partial).
function resolvePreset(preset, today) {
  switch (preset) {
    case 'today': return { since: today, until: today };
    case 'yesterday': { const y = addDays(today, -1); return { since: y, until: y }; }
    case 'last_3': return { since: addDays(today, -3), until: addDays(today, -1) };
    case 'last_4': return { since: addDays(today, -4), until: addDays(today, -1) };
    case 'last_7': return { since: addDays(today, -7), until: addDays(today, -1) };
    case 'last_14': return { since: addDays(today, -14), until: addDays(today, -1) };
    case 'last_30': return { since: addDays(today, -30), until: addDays(today, -1) };
    case 'this_week': return { since: mondayOf(today), until: today };
    case 'last_week': {
      const thisMonday = mondayOf(today);
      return { since: addDays(thisMonday, -7), until: addDays(thisMonday, -1) };
    }
    case 'this_month': return { since: monthStart(today), until: today };
    case 'last_90': return { since: addDays(today, -90), until: addDays(today, -1) };
    case 'last_365': return { since: addDays(today, -365), until: addDays(today, -1) };
    case 'last_month': { const prevLast = addDays(monthStart(today), -1); return { since: monthStart(prevLast), until: prevLast }; }
    case 'ytd': return { since: `${today.slice(0, 4)}-01-01`, until: today };
    default: throw new HttpError(400, `Unknown preset "${preset}"`);
  }
}

// Previous comparison period. Week-/month-to-date presets compare against
// the SAME elapsed span of the previous week/month (Mon-Wed vs last
// Mon-Wed), which is the meaningful like-for-like; everything else (and
// Custom) compares against the equal-length block immediately before.
function previousPeriod(preset, range) {
  const len = daysBetweenInclusive(range.since, range.until);
  if (preset === 'this_week') {
    return { since: addDays(range.since, -7), until: addDays(range.until, -7) };
  }
  if (preset === 'this_month') {
    const prevMonthLast = addDays(range.since, -1);
    const prevStart = monthStart(prevMonthLast);
    const sameSpanEnd = addDays(prevStart, len - 1);
    return { since: prevStart, until: sameSpanEnd < prevMonthLast ? sameSpanEnd : prevMonthLast };
  }
  const until = addDays(range.since, -1);
  return { since: addDays(until, -(len - 1)), until };
}

// Turns query params into a validated range. A named preset is always
// resolved server-side (so the timezone logic lives in exactly one place);
// explicit since/until (or preset=custom) is validated and used as given.
function parseRangeParams(query, now = new Date()) {
  const today = ymdInZone(now);
  let preset = query.preset ? String(query.preset) : null;
  if (!preset) preset = query.since || query.until ? 'custom' : DEFAULT_PRESET;
  if (!PRESETS.includes(preset)) throw new HttpError(400, `Unknown preset "${preset}"`);

  let range;
  if (preset === 'custom') {
    const since = String(query.since || '');
    const until = String(query.until || '');
    if (!isValidYmd(since) || !isValidYmd(until)) {
      throw new HttpError(400, 'Custom range needs valid since and until dates (YYYY-MM-DD)');
    }
    if (since > until) throw new HttpError(400, 'Start date must be on or before the end date');
    if (daysBetweenInclusive(since, until) > MAX_CUSTOM_DAYS) {
      throw new HttpError(400, `Custom range can be at most ${MAX_CUSTOM_DAYS} days`);
    }
    range = { since, until };
  } else {
    range = resolvePreset(preset, today);
  }
  const compare = query.compare === '1' || query.compare === 'true';
  return {
    preset,
    label: PRESET_LABELS[preset],
    range,
    today,
    compare,
    compareRange: compare ? previousPeriod(preset, range) : null,
  };
}

// ── Metric math ─────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, dp) {
  if (v === null) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function safeDiv(a, b) {
  return b > 0 ? a / b : null;
}

// raw: summed additive columns for one ad / one account over a date range.
function deriveMetrics(raw) {
  const spend = num(raw.spend);
  const purchases = num(raw.purchases);
  const purchaseValue = num(raw.purchase_value);
  const addToCart = num(raw.add_to_cart);
  const outboundClicks = num(raw.outbound_clicks);
  const impressions = num(raw.impressions);
  return {
    spend: round(spend, 2),
    purchases,
    purchase_value: round(purchaseValue, 2),
    add_to_cart: addToCart,
    outbound_clicks: outboundClicks,
    impressions,
    cpa: round(safeDiv(spend, purchases), 2),
    // Purchase ROAS = purchase value / spend, from the SAME summed columns (same omni_purchase action, same attribution window,
    // same period) as the Purchase Value and Amount Spent shown beside it. null (never 0) when nothing was spent.
    roas: round(safeDiv(purchaseValue, spend), 2),
    cost_per_atc: round(safeDiv(spend, addToCart), 2),
    outbound_ctr: round(impressions > 0 ? (outboundClicks / impressions) * 100 : null, 4),
    // CPM = cost per 1,000 impressions = Spend / Impressions x 1,000, always from the SAME summed columns and period as the rest (an aggregate is total spend over
    // total impressions: individual ad CPMs are never averaged). null (never 0) when there are no impressions.
    cpm: round(impressions > 0 ? (spend / impressions) * 1000 : null, 2),
  };
}

// ── Sync coverage / freshness ───────────────────────────────────────────
// A daily row only exists for an ad that delivered, so "no rows for a day"
// can mean either "nothing delivered" or "never synced" -- the rows alone
// can't tell them apart. Coverage is therefore read from meta_sync_runs
// (successful runs and the date range each one pulled):
//   complete -- a successful run covering the day STARTED after that day
//               ended (in the reporting timezone), so it saw the full day
//   partial  -- covered only by runs that started while the day was still
//               in progress (typical for today)
//   missing  -- no successful run covers the day
function compactRanges(dates) {
  const ranges = [];
  dates.forEach((d) => {
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.until, 1) === d) last.until = d;
    else ranges.push({ since: d, until: d });
  });
  return ranges;
}

async function getCoverage(range, now = new Date()) {
  const { rows } = await pool.query(
    `SELECT to_char(range_since, 'YYYY-MM-DD') AS since,
            to_char(range_until, 'YYYY-MM-DD') AS until,
            started_at
       FROM meta_sync_runs
      WHERE status = 'success' AND run_type IN ('default', 'backfill')
        AND range_until >= $1 AND range_since <= $2`,
    [range.since, range.until]
  );
  const days = listDates(range.since, range.until);
  const complete = [];
  const partial = [];
  const missing = [];
  days.forEach((day) => {
    const covering = rows.filter((r) => r.since <= day && day <= r.until);
    if (!covering.length) { missing.push(day); return; }
    const dayEnd = zonedDayStartUtc(addDays(day, 1));
    const sawFullDay = covering.some((r) => new Date(r.started_at) >= dayEnd);
    (sawFullDay ? complete : partial).push(day);
  });
  const synced = complete.length + partial.length;
  return {
    total_days: days.length,
    complete_days: complete.length,
    partial_days: partial.length,
    missing_days: missing.length,
    fully_synced: missing.length === 0 && partial.length === 0,
    status: synced === 0 ? 'none' : (missing.length || partial.length ? 'partial' : 'complete'),
    missing_ranges: compactRanges(missing),
    partial_ranges: compactRanges(partial),
    synced_ranges: compactRanges([...complete, ...partial].sort()),
    checked_at: now.toISOString(),
  };
}

async function getFreshness() {
  const { rows } = await pool.query(
    `SELECT finished_at, to_char(range_until, 'YYYY-MM-DD') AS range_until
       FROM meta_sync_runs
      WHERE status = 'success' AND run_type IN ('default', 'backfill') AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`
  );
  const { rows: acct } = await pool.query(
    `SELECT currency, timezone_name FROM meta_account_settings ORDER BY fetched_at DESC LIMIT 1`
  );
  const a = acct[0] || {};
  return {
    last_synced_at: rows[0] ? rows[0].finished_at.toISOString() : null,
    latest_synced_date: rows[0] ? rows[0].range_until : null,
    currency: a.currency || null,
    account_timezone: a.timezone_name || null,
    // The page always reports in REPORTING_TIMEZONE; flag (don't hide) a
    // mismatch with what Meta says the account uses.
    timezone_mismatch: !!(a.timezone_name && a.timezone_name !== REPORTING_TIMEZONE),
  };
}

// ── Campaign / funnel filter ────────────────────────────────────────────
// ?funnel=TOF|TOM|MOF|multiple|unknown  and/or  ?campaign_id=<exact Meta campaign id>. Applied to the headline
// metrics, the compare period AND the table alike, so the numbers always describe the same population of ads.
const FUNNEL_FILTERS = new Set(['TOF', 'TOM', 'MOF', 'multiple', 'unknown']);
const CAMPAIGN_ID_RE = /^[0-9]{1,32}$/;
function parseFilter(query = {}) {
  const funnel = FUNNEL_FILTERS.has(query.funnel) ? query.funnel : null;
  const campaignId = CAMPAIGN_ID_RE.test(String(query.campaign_id || '')) ? String(query.campaign_id) : null;
  // Dynamic Product Ads are left out of creative performance by default (lib/metaDpa.js); ?dpa=include brings them back for reporting. Nothing is deleted.
  const dpa = dpaLib.parseDpaMode(query);
  return { funnel, campaignId, dpa, excludeDpa: dpa === 'exclude', active: !!(funnel || campaignId) };
}
// Restricts an insights table (alias given) to the ads in the filter; params are appended to `params`.
function adFilterSql(filter, params, alias = 'd') {
  if (!filter || !(filter.active || filter.excludeDpa)) return '';
  const conds = [];
  if (filter.funnel) { params.push(filter.funnel); conds.push(`COALESCE(mc.funnel, 'unknown') = $${params.length}`); }
  if (filter.campaignId) { params.push(filter.campaignId); conds.push(`fa.meta_campaign_id = $${params.length}`); }
  if (filter.excludeDpa) conds.push(dpaLib.notDpaPredicate('fa', 'mc'));
  return ` AND ${alias}.meta_ad_id IN (SELECT fa.meta_ad_id FROM meta_ads fa LEFT JOIN meta_campaigns mc ON mc.meta_campaign_id = fa.meta_campaign_id WHERE ${conds.join(' AND ')})`;
}

// ── Queries ─────────────────────────────────────────────────────────────
const ACTIVITY = '(SUM(d.spend) > 0 OR SUM(d.impressions) > 0)';

async function getTotals(range, filter) {
  const params = [range.since, range.until];
  const filterSql = adFilterSql(filter, params, 'd');
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(spend), 0) AS spend,
            COALESCE(SUM(purchases), 0) AS purchases,
            COALESCE(SUM(purchase_value), 0) AS purchase_value,
            COALESCE(SUM(add_to_cart), 0) AS add_to_cart,
            COALESCE(SUM(outbound_clicks), 0) AS outbound_clicks,
            COALESCE(SUM(impressions), 0) AS impressions,
            COUNT(DISTINCT meta_ad_id) FILTER (WHERE spend > 0 OR impressions > 0) AS ads_with_activity,
            COUNT(DISTINCT insight_date) AS days_with_rows
       FROM meta_ad_insights_daily d
      WHERE d.insight_date BETWEEN $1 AND $2${filterSql}`,
    params
  );
  const r = rows[0];
  return {
    ...deriveMetrics(r),
    ads_with_activity: num(r.ads_with_activity),
    days_with_rows: num(r.days_with_rows),
  };
}

// What the DPA switch is hiding / including for a period: ads with activity that are DPAs, and their spend. Always computed (whatever the mode) so the page can say so.
async function getDpaInfo(range, filter) {
  const mode = filter && filter.dpa ? filter.dpa : 'exclude';
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT d.meta_ad_id) FILTER (WHERE d.spend > 0 OR d.impressions > 0) AS ads, COALESCE(SUM(d.spend), 0) AS spend
       FROM meta_ad_insights_daily d
       JOIN meta_ads a ON a.meta_ad_id = d.meta_ad_id
       LEFT JOIN meta_campaigns mc ON mc.meta_campaign_id = a.meta_campaign_id
      WHERE d.insight_date BETWEEN $1 AND $2 AND ${dpaLib.dpaPredicate('a', 'mc')}`,
    [range.since, range.until]
  );
  const ads = num(rows[0].ads); const spend = round(num(rows[0].spend), 2);
  return { mode, excluded: mode === 'exclude', ads, spend,
    label: mode === 'exclude' ? 'DPAs excluded' : 'DPAs included',
    note: mode === 'exclude'
      ? `Dynamic Product Ads are excluded from these figures${ads ? ` (${ads} ad${ads === 1 ? '' : 's'}, $${Math.round(spend).toLocaleString('en-AU')} spend in this period)` : ''}. They are still stored; switch "Include DPAs" on to see them.`
      : `These figures include Dynamic Product Ads${ads ? ` (${ads} ad${ads === 1 ? '' : 's'}, $${Math.round(spend).toLocaleString('en-AU')} spend in this period)` : ''}.` };
}

async function getSummary(parsed, now = new Date(), filter = null) {
  const [totals, coverage, freshness, dpa] = await Promise.all([
    getTotals(parsed.range, filter),
    getCoverage(parsed.range, now),
    getFreshness(),
    getDpaInfo(parsed.range, filter),
  ]);
  const out = {
    preset: parsed.preset,
    label: parsed.label,
    timezone: REPORTING_TIMEZONE,
    today: parsed.today,
    range: parsed.range,
    totals,
    coverage,
    freshness,
    // Exact range-level Reach/Frequency from the cache (null + status until loaded).
    reach_frequency: reachStore.summaryFrom(await reachStore.getStatus(parsed.range, parsed.today, { now: now.getTime() })),
    filter: filter && filter.active ? { funnel: filter.funnel, campaign_id: filter.campaignId } : null,
    dpa,
    compare: null,
  };
  // Exact Reach / Frequency is whole-account (Meta cannot split it by ad type): when DPAs are excluded from the other figures it still includes them, and says so.
  if (dpa.excluded && dpa.ads > 0 && out.reach_frequency) out.reach_frequency = { ...out.reach_frequency, scope_note: 'Whole account, including DPAs (Meta cannot split Reach by ad type)' };
  if (filter && filter.active) {
    // Exact Reach / Frequency is a unique-people figure Meta computes for the WHOLE account over the period; it cannot be
    // derived for a funnel / campaign subset from daily rows or from per-ad reach, so it is withheld rather than faked.
    out.reach_frequency = { available: false, state: 'filtered', reach: null, frequency: null, pulled_at: null, stale: false, includes_today: false, last_error: null, source: 'meta_range',
      reason: 'Exact Reach and Frequency are only available for the whole account. Clear the funnel / campaign filter to see them.' };
  }
  if (parsed.compareRange) {
    const [prevTotals, prevCoverage] = await Promise.all([
      getTotals(parsed.compareRange, filter),
      getCoverage(parsed.compareRange, now),
    ]);
    out.compare = { range: parsed.compareRange, totals: prevTotals, coverage: prevCoverage };
  }
  return out;
}

const STATUS_FILTERS = {
  all: null,
  active: `a.effective_status = 'ACTIVE'`,
  paused: `a.effective_status IN ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED')`,
  other: `(a.effective_status IS NULL OR a.effective_status NOT IN ('ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'))`,
};

// Whitelisted sort keys -> SQL on the aggregated CTE (never user text in SQL).
const SORT_SQL = {
  spend: 'agg.spend',
  purchases: 'agg.purchases',
  cpa: 'agg.spend / NULLIF(agg.purchases, 0)',
  add_to_cart: 'agg.add_to_cart',
  cost_per_atc: 'agg.spend / NULLIF(agg.add_to_cart, 0)',
  outbound_ctr: 'agg.outbound_clicks::numeric / NULLIF(agg.impressions, 0)',
  cpm: 'agg.spend / NULLIF(agg.impressions, 0)',
  purchase_value: 'agg.purchase_value',
  roas: 'agg.purchase_value / NULLIF(agg.spend, 0)',
  ad_name: 'lower(a.ad_name)',
  status: 'a.effective_status',
};

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Reach / Frequency sort only when the Reach cache can supply them (see getAds).
const REACH_SORTS = new Set(['reach', 'frequency']);

function parseAdsQuery(query) {
  const sort = SORT_SQL[query.sort] || REACH_SORTS.has(query.sort) ? query.sort : 'spend';
  const dir = String(query.dir).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const status = Object.prototype.hasOwnProperty.call(STATUS_FILTERS, query.status) ? query.status : 'all';
  const q = String(query.q || '').trim().slice(0, 200);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 25));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { sort, dir, status, q, pageSize, page };
}

// One row per ad that had activity in the range (spend or impressions),
// aggregated in SQL and paged in SQL -- the browser never receives the
// 29k-ad inventory or raw daily rows.
async function getAds(parsed, query) {
  const opts = parseAdsQuery(query);
  const filter = parseFilter(query);
  const healthDays = funnelHealth.rangeDays(parsed.range);
  // the benchmarks in force: those saved in Settings (Meta Performance), else the built-in approved ones (lazy require: metaBenchmarks needs HttpError from here)
  const bench = await require('./metaBenchmarks').getEffective();
  const healthCtx = { rules: bench.rules, coded: bench.coded };
  // Where this range's per-ad Reach/Frequency can come from (never Meta, only the stored cache).
  const reachStatus = await reachStore.getStatus(parsed.range, parsed.today);
  const reachFrom = reachStatus.ad_values; // 'stored_daily' (one day) | 'meta_range' (cached pull) | null
  const pullId = reachFrom === 'meta_range' ? Number(reachStatus.pull_id) : null; // integer from our own table
  const reachJoin = pullId ? `LEFT JOIN meta_ad_range_reach rr ON rr.pull_id = ${pullId} AND rr.meta_ad_id = agg.meta_ad_id` : '';
  const reachSel = pullId ? 'rr.reach AS rr_reach, rr.frequency AS rr_frequency' : 'NULL::bigint AS rr_reach, NULL::numeric AS rr_frequency';
  const reachExpr = { reach: pullId ? 'rr.reach' : 'agg.day_reach', frequency: pullId ? 'rr.frequency' : 'agg.day_frequency' };
  const sortSql = REACH_SORTS.has(opts.sort) ? (reachFrom ? reachExpr[opts.sort] : SORT_SQL.spend) : SORT_SQL[opts.sort];
  const params = [parsed.range.since, parsed.range.until];
  const where = [];
  if (STATUS_FILTERS[opts.status]) where.push(STATUS_FILTERS[opts.status]);
  if (filter.funnel) { params.push(filter.funnel); where.push(`COALESCE(mc.funnel, 'unknown') = $${params.length}`); }
  if (filter.campaignId) { params.push(filter.campaignId); where.push(`a.meta_campaign_id = $${params.length}`); }
  if (filter.excludeDpa) where.push(dpaLib.notDpaPredicate('a', 'mc'));
  if (opts.q) {
    params.push(`%${escapeLike(opts.q)}%`);
    const like = `$${params.length}`;
    // Name match, or an exact Meta Ad ID paste.
    params.push(opts.q);
    where.push(`(a.ad_name ILIKE ${like} ESCAPE '\\' OR a.meta_ad_id = $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const cte = `
    WITH agg AS (
      SELECT d.meta_ad_id,
             SUM(d.spend) AS spend, SUM(d.purchases) AS purchases,
             SUM(d.purchase_value) AS purchase_value, SUM(d.add_to_cart) AS add_to_cart,
             SUM(d.outbound_clicks) AS outbound_clicks, SUM(d.impressions) AS impressions,
             COUNT(*) AS days_active, MAX(d.reach) AS day_reach, MAX(d.frequency) AS day_frequency
        FROM meta_ad_insights_daily d
       WHERE d.insight_date BETWEEN $1 AND $2
       GROUP BY d.meta_ad_id
      HAVING ${ACTIVITY}
    )`;
  const countRes = await pool.query(
    `${cte} SELECT COUNT(*) AS total FROM agg JOIN meta_ads a ON a.meta_ad_id = agg.meta_ad_id LEFT JOIN meta_campaigns mc ON mc.meta_campaign_id = a.meta_campaign_id ${whereSql}`,
    params
  );
  const total = num(countRes.rows[0].total);
  const fcRes = await pool.query(
    `${cte} SELECT COALESCE(mc.funnel, 'unknown') AS funnel, COUNT(*) AS n FROM agg JOIN meta_ads a ON a.meta_ad_id = agg.meta_ad_id LEFT JOIN meta_campaigns mc ON mc.meta_campaign_id = a.meta_campaign_id ${whereSql} GROUP BY 1`,
    params
  );
  // how many of the ads in this view can ever be judged: a funnel is read from the campaign name; Unknown / Mixed are never coloured
  const funnelCounts = { TOF: 0, TOM: 0, MOF: 0, multiple: 0, unknown: 0 };
  fcRes.rows.forEach((r) => { funnelCounts[r.funnel] = (funnelCounts[r.funnel] || 0) + num(r.n); });
  const listParams = [...params, opts.pageSize, (opts.page - 1) * opts.pageSize];
  // NULLS LAST keeps "no purchases" (null CPA) at the bottom in either
  // direction; spend then meta_ad_id are tiebreakers so paging is stable
  // (no ad can appear on two pages or be skipped).
  const { rows } = await pool.query(
    `${cte}
     SELECT agg.*, a.ad_name, a.effective_status, a.match_status, a.meta_campaign_id, mc.name AS campaign_name, COALESCE(mc.funnel, 'unknown') AS funnel, ${reachSel}
       FROM agg JOIN meta_ads a ON a.meta_ad_id = agg.meta_ad_id
       LEFT JOIN meta_campaigns mc ON mc.meta_campaign_id = a.meta_campaign_id
       ${reachJoin}
       ${whereSql}
      ORDER BY ${sortSql} ${opts.dir} NULLS LAST, agg.spend DESC, agg.meta_ad_id ASC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  // Relative magnitude for the little bars under Amount Spent / Purchases: the largest value anywhere in the FILTERED result set (not just this page),
  // so a bar means the same thing on every page and recalculates when a filter changes. Read-only; no metric is changed.
  const scaleRes = await pool.query(
    `${cte} SELECT MAX(agg.spend) AS spend_max, MAX(agg.purchases) AS purchases_max FROM agg JOIN meta_ads a ON a.meta_ad_id = agg.meta_ad_id LEFT JOIN meta_campaigns mc ON mc.meta_campaign_id = a.meta_campaign_id ${whereSql}`,
    params
  );
  const scale = { spend_max: round(num(scaleRes.rows[0].spend_max), 2), purchases_max: num(scaleRes.rows[0].purchases_max) };
  // Previous-period figures for exactly the ads on this page (only when "Compare to previous period" is on). Same columns and same derivation as the current period
  // (deriveMetrics); shown only when BOTH periods are fully synced, exactly like the summary cards. Reach / Frequency are unique-people figures that cannot be
  // rebuilt for a previous period without a separate Meta pull, so they carry no comparison.
  let compare = null;
  const prevByAd = new Map();
  if (parsed.compareRange) {
    const [curCov, prevCov] = await Promise.all([getCoverage(parsed.range, new Date()), getCoverage(parsed.compareRange, new Date())]);
    const available = curCov.status !== 'none' && curCov.missing_days === 0 && prevCov.status !== 'none' && prevCov.missing_days === 0;
    compare = { range: parsed.compareRange, available, reason: available ? null : (prevCov.status === 'none' ? 'The previous period has no synced data' : 'The previous period is not fully synced') };
    if (available && rows.length) {
      const prev = await pool.query(
        `SELECT d.meta_ad_id, SUM(d.spend) AS spend, SUM(d.purchases) AS purchases, SUM(d.purchase_value) AS purchase_value, SUM(d.add_to_cart) AS add_to_cart,
                SUM(d.outbound_clicks) AS outbound_clicks, SUM(d.impressions) AS impressions
           FROM meta_ad_insights_daily d WHERE d.insight_date BETWEEN $1 AND $2 AND d.meta_ad_id = ANY($3::text[]) GROUP BY d.meta_ad_id`,
        [parsed.compareRange.since, parsed.compareRange.until, rows.map((r) => r.meta_ad_id)]
      );
      prev.rows.forEach((r) => prevByAd.set(r.meta_ad_id, deriveMetrics(r)));
    }
  }
  return {
    range: parsed.range,
    page: opts.page,
    page_size: opts.pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / opts.pageSize)),
    sort: opts.sort,
    dir: opts.dir,
    status: opts.status,
    q: opts.q,
    filter: filter.active ? { funnel: filter.funnel, campaign_id: filter.campaignId } : null,
    dpa: await getDpaInfo(parsed.range, filter),
    scale,
    compare,
    ads: rows.map((r) => ({
      meta_ad_id: r.meta_ad_id,
      ad_name: r.ad_name,
      effective_status: r.effective_status,
      match_status: r.match_status,
      campaign_id: r.meta_campaign_id || null,
      campaign_name: r.campaign_name || null,
      funnel: r.funnel,
      days_active: num(r.days_active),
      ...deriveMetrics(r),
      ...adReach(reachFrom, r),
      prev: prevByAd.get(r.meta_ad_id) || null,
    })).map((a) => ({
      ...a,
      // Only WNDRR-confirmed benchmarks (lib/metaFunnelHealth.js); null = neutral. Frequency is judged only for ~4-day ranges.
      cpa_health: funnelHealth.classify(a.funnel, 'cpa', a.cpa, { days: healthDays }, healthCtx),
      frequency_health: funnelHealth.classify(a.funnel, 'frequency', a.frequency, { days: healthDays }, healthCtx),
      reach_health: funnelHealth.classify(a.funnel, 'reach', a.reach, { days: healthDays }, healthCtx), // coloured only where a Reach benchmark has been set
    })),
    health: { ...funnelHealth.status({ range: parsed.range, rules: bench.rules, coded: bench.coded, source: bench.source === 'settings' ? 'settings' : null }), funnel_counts: funnelCounts },
    reach_info: {
      state: reachFrom ? 'ready' : reachStatus.state, source: reachFrom, pulled_at: reachStatus.pulled_at, stale: reachFrom === 'meta_range' && reachStatus.stale,
      includes_today: reachStatus.includes_today, last_error: reachStatus.last_error,
    },
  };
}

// ── Best Ads (a presentation layer over the same stored data) ───────────────────────────────────────────────────────────────────────
// Individual Meta ads ranked across the WHOLE eligible set (never just the page that happens to be loaded), with the same attribution, metric definitions, DPA rule,
// funnel / campaign filters and Reach sources as the Performance table. Nothing is grouped or de-duplicated: one card = one Meta ad id.
//   * Rank by: Purchase Value / Purchases / Amount Spent / ROAS (highest first), CPA (lowest first), Reach (highest first, only where this period's per-ad Reach is available).
//   * Minimum spend (default $500, 0 allowed) limits the population. CPA and ROAS rankings additionally need a minimum number of purchases (default 5) so an ad with one
//     lucky sale cannot win; ads with no purchases have no CPA at all. The rule used is returned so the page can show it.
//   * The headline totals are for the SAME population (all ads that match the filters), and the previous-period totals are for those same ads (like for like).
const BEST_RANKS = {
  purchase_value: { dir: 'desc', sql: 'agg.purchase_value', label: 'Purchase Value' },
  purchases: { dir: 'desc', sql: 'agg.purchases', label: 'Purchases' },
  cpa: { dir: 'asc', sql: 'agg.spend / NULLIF(agg.purchases, 0)', label: 'CPA', needsPurchases: true },
  roas: { dir: 'desc', sql: 'agg.purchase_value / NULLIF(agg.spend, 0)', label: 'ROAS', needsPurchases: true },
  spend: { dir: 'desc', sql: 'agg.spend', label: 'Amount Spent' },
  reach: { dir: 'desc', sql: null, label: 'Reach', needsReach: true },
};
const BEST_DEFAULTS = { min_spend: 500, min_purchases: 5, page_size: 24, max_page_size: 60 };

function parseBestQuery(query = {}) {
  const rank = Object.prototype.hasOwnProperty.call(BEST_RANKS, query.rank) ? query.rank : 'purchase_value';
  const nn = (v, d, max) => { const n = Number(v); return v === undefined || v === '' || !Number.isFinite(n) ? d : Math.min(max, Math.max(0, n)); };
  const status = ['active', 'paused'].includes(query.status) ? query.status : 'all';
  return {
    rank,
    minSpend: nn(query.min_spend, BEST_DEFAULTS.min_spend, 1000000),
    minPurchases: Math.floor(nn(query.min_purchases, BEST_DEFAULTS.min_purchases, 1000)),
    status,
    q: String(query.q || '').trim().slice(0, 200),
    page: Math.max(1, parseInt(query.page, 10) || 1),
    pageSize: Math.min(BEST_DEFAULTS.max_page_size, Math.max(1, parseInt(query.page_size, 10) || BEST_DEFAULTS.page_size)),
  };
}

async function getBestAds(parsed, query) {
  const o = parseBestQuery(query);
  const filter = parseFilter(query);
  const spec = BEST_RANKS[o.rank];
  const reachStatus = await reachStore.getStatus(parsed.range, parsed.today);
  const reachFrom = reachStatus.ad_values;
  const pullId = reachFrom === 'meta_range' ? Number(reachStatus.pull_id) : null;
  const reachJoin = pullId ? `LEFT JOIN meta_ad_range_reach rr ON rr.pull_id = ${pullId} AND rr.meta_ad_id = agg.meta_ad_id` : '';
  const reachSel = pullId ? 'rr.reach AS rr_reach, rr.frequency AS rr_frequency' : 'NULL::bigint AS rr_reach, NULL::numeric AS rr_frequency';
  const reachExpr = pullId ? 'rr.reach' : 'agg.day_reach';
  // Reach can only rank when this period's per-ad Reach exists; otherwise the page says so and ranks by Purchase Value (never silently by something else)
  let used = o.rank;
  let fallback = null;
  if (spec.needsReach && !reachFrom) { used = 'purchase_value'; fallback = { requested: 'reach', used: 'purchase_value', reason: 'Per-ad Reach for this period has not been loaded from Meta yet (use Refresh now), so the ads are ranked by Purchase Value instead.' }; }
  const useSpec = BEST_RANKS[used];
  const rankSql = used === 'reach' ? reachExpr : useSpec.sql;

  const params = [parsed.range.since, parsed.range.until, o.minSpend];
  const where = [];
  if (o.status === 'active') where.push(STATUS_FILTERS.active);
  if (o.status === 'paused') where.push(STATUS_FILTERS.paused);
  if (filter.funnel) { params.push(filter.funnel); where.push(`COALESCE(mc.funnel, 'unknown') = $${params.length}`); }
  if (filter.campaignId) { params.push(filter.campaignId); where.push(`a.meta_campaign_id = $${params.length}`); }
  if (filter.excludeDpa) where.push(dpaLib.notDpaPredicate('a', 'mc'));
  if (o.q) {
    params.push(`%${escapeLike(o.q)}%`); const like = `$${params.length}`;
    params.push(o.q); const exact = `$${params.length}`;
    where.push(`(a.ad_name ILIKE ${like} ESCAPE '\\' OR a.meta_ad_id = ${exact} OR EXISTS (SELECT 1 FROM meta_ad_products bp WHERE bp.meta_ad_id = a.meta_ad_id AND bp.product_name ILIKE ${like} ESCAPE '\\'))`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const cte = `
    WITH agg AS (
      SELECT d.meta_ad_id,
             SUM(d.spend) AS spend, SUM(d.purchases) AS purchases,
             SUM(d.purchase_value) AS purchase_value, SUM(d.add_to_cart) AS add_to_cart,
             SUM(d.outbound_clicks) AS outbound_clicks, SUM(d.impressions) AS impressions,
             MAX(d.reach) AS day_reach, MAX(d.frequency) AS day_frequency
        FROM meta_ad_insights_daily d
       WHERE d.insight_date BETWEEN $1 AND $2
       GROUP BY d.meta_ad_id
      HAVING ${ACTIVITY} AND SUM(d.spend) >= $3
    )`;
  const joins = 'FROM agg JOIN meta_ads a ON a.meta_ad_id = agg.meta_ad_id LEFT JOIN meta_campaigns mc ON mc.meta_campaign_id = a.meta_campaign_id';
  // 1. the whole population these filters describe: its totals are the headline figures
  const popRes = await pool.query(
    `${cte} SELECT COUNT(*) AS n, COALESCE(SUM(agg.spend),0) AS spend, COALESCE(SUM(agg.purchases),0) AS purchases, COALESCE(SUM(agg.purchase_value),0) AS purchase_value,
            COALESCE(SUM(agg.add_to_cart),0) AS add_to_cart, COALESCE(SUM(agg.outbound_clicks),0) AS outbound_clicks, COALESCE(SUM(agg.impressions),0) AS impressions
       ${joins} ${whereSql}`, params);
  const pr = popRes.rows[0];
  const popAds = num(pr.n);
  const totals = deriveMetrics(pr);
  // 2. eligibility for the chosen ranking (the rule is shown on the page)
  const elig = [];
  if (useSpec.needsPurchases) elig.push(`agg.purchases >= ${Math.max(1, o.minPurchases)} AND agg.spend > 0`);
  if (used === 'reach') elig.push(`${reachExpr} IS NOT NULL`);
  const eligSql = elig.length ? `${whereSql ? `${whereSql} AND` : 'WHERE'} ${elig.join(' AND ')}` : whereSql;
  const eligN = elig.length ? num((await pool.query(`${cte} SELECT COUNT(*) AS n ${joins} ${reachJoin} ${eligSql}`, params)).rows[0].n) : popAds;
  // ads that WOULD have been in the population without the minimum-spend rule (so "none meet the minimum" can be told apart from "no ads at all")
  let belowMin = 0;
  if (o.minSpend > 0) {
    const p0 = params.slice(); p0[2] = 0;
    belowMin = Math.max(0, num((await pool.query(`${cte} SELECT COUNT(*) AS n ${joins} ${whereSql}`, p0)).rows[0].n) - popAds);
  }
  // 3. one page of the ranked eligible ads
  const listParams = [...params, o.pageSize, (o.page - 1) * o.pageSize];
  const { rows } = await pool.query(
    `${cte}
     SELECT agg.*, a.ad_name, a.effective_status, a.meta_campaign_id, mc.name AS campaign_name, COALESCE(mc.funnel, 'unknown') AS funnel, ${reachSel},
            (SELECT array_agg(DISTINCT bp.product_name ORDER BY bp.product_name) FROM meta_ad_products bp WHERE bp.meta_ad_id = a.meta_ad_id AND bp.product_name IS NOT NULL) AS products
       ${joins} ${reachJoin} ${eligSql}
      ORDER BY ${rankSql} ${useSpec.dir} NULLS LAST, agg.purchase_value DESC, agg.spend DESC, agg.meta_ad_id ASC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams);
  // 4. previous period, for the SAME ads (like for like), only when both periods are fully synced
  let prev = null;
  if (parsed.compareRange) {
    const [curCov, prevCov] = await Promise.all([getCoverage(parsed.range, new Date()), getCoverage(parsed.compareRange, new Date())]);
    const available = curCov.status !== 'none' && curCov.missing_days === 0 && prevCov.status !== 'none' && prevCov.missing_days === 0;
    prev = { range: parsed.compareRange, available, reason: available ? null : (prevCov.status === 'none' ? 'The previous period has no synced data' : 'The previous period is not fully synced'), totals: null };
    if (available) {
      const pp = [...params, parsed.compareRange.since, parsed.compareRange.until];
      const r = await pool.query(
        `${cte} SELECT COALESCE(SUM(d.spend),0) AS spend, COALESCE(SUM(d.purchases),0) AS purchases, COALESCE(SUM(d.purchase_value),0) AS purchase_value, COALESCE(SUM(d.add_to_cart),0) AS add_to_cart,
                COALESCE(SUM(d.outbound_clicks),0) AS outbound_clicks, COALESCE(SUM(d.impressions),0) AS impressions
           FROM meta_ad_insights_daily d
          WHERE d.insight_date BETWEEN $${pp.length - 1} AND $${pp.length}
            AND d.meta_ad_id IN (SELECT agg.meta_ad_id ${joins} ${whereSql})`, pp);
      prev.totals = deriveMetrics(r.rows[0]);
    }
  }
  const coverage = await getCoverage(parsed.range, new Date());
  const minRuleText = useSpec.needsPurchases
    ? `${useSpec.label} ranking only includes ads with at least ${Math.max(1, o.minPurchases)} purchases and at least $${o.minSpend.toLocaleString('en-AU')} spent, so an ad with one lucky sale cannot top the list. Both limits can be changed.`
    : used === 'reach' ? 'Reach ranking only includes ads that have a Reach figure for this period.' : null;
  return {
    range: parsed.range, preset: parsed.preset, label: parsed.label, timezone: REPORTING_TIMEZONE, today: parsed.today,
    rank: { requested: o.rank, used, label: useSpec.label, dir: useSpec.dir, fallback },
    rules: { min_spend: o.minSpend, min_purchases: o.minPurchases, purchases_rule: !!useSpec.needsPurchases, text: minRuleText },
    filter: { funnel: filter.funnel, campaign_id: filter.campaignId, status: o.status, q: o.q },
    dpa: await getDpaInfo(parsed.range, filter),
    page: o.page, page_size: o.pageSize,
    total: eligN, total_pages: Math.max(1, Math.ceil(eligN / o.pageSize)),
    population: { ads: popAds, totals: { ...totals, ads_with_activity: popAds }, previous: prev, below_min_spend: belowMin, excluded_by_rule: Math.max(0, popAds - eligN) },
    coverage,
    reach_info: { state: reachFrom ? 'ready' : reachStatus.state, source: reachFrom, pulled_at: reachStatus.pulled_at, stale: reachFrom === 'meta_range' && reachStatus.stale },
    ads: rows.map((r, i) => ({
      rank: (o.page - 1) * o.pageSize + i + 1,
      meta_ad_id: r.meta_ad_id, ad_name: r.ad_name, effective_status: r.effective_status,
      campaign_id: r.meta_campaign_id || null, campaign_name: r.campaign_name || null, funnel: r.funnel,
      products: r.products || [],
      ...deriveMetrics(r), ...adReach(reachFrom, r),
    })),
  };
}

// Per-ad Reach / Frequency for one row, from whichever exact source this range has (else null).
function adReach(from, r) {
  if (from === 'stored_daily') return { reach: r.day_reach === null ? null : num(r.day_reach), frequency: r.day_frequency === null ? null : round(num(r.day_frequency), 2) };
  if (from === 'meta_range') return { reach: r.rr_reach === null || r.rr_reach === undefined ? null : num(r.rr_reach), frequency: r.rr_frequency === null || r.rr_frequency === undefined ? null : round(num(r.rr_frequency), 2) };
  return { reach: null, frequency: null };
}

async function getAdDetail(metaAdId, parsed) {
  const { rows: adRows } = await pool.query(
    `SELECT meta_ad_id, ad_name, effective_status, created_time, meta_campaign_id,
            meta_adset_id, meta_creative_id, match_status
       FROM meta_ads WHERE meta_ad_id = $1`,
    [metaAdId]
  );
  if (!adRows.length) throw new HttpError(404, 'Ad not found');
  const ad = adRows[0];
  const { rows: daily } = await pool.query(
    `SELECT to_char(insight_date, 'YYYY-MM-DD') AS date, spend, purchases, purchase_value,
            add_to_cart, outbound_clicks, impressions
       FROM meta_ad_insights_daily
      WHERE meta_ad_id = $1 AND insight_date BETWEEN $2 AND $3
      ORDER BY insight_date`,
    [metaAdId, parsed.range.since, parsed.range.until]
  );
  const sums = daily.reduce((acc, r) => ({
    spend: acc.spend + num(r.spend),
    purchases: acc.purchases + num(r.purchases),
    purchase_value: acc.purchase_value + num(r.purchase_value),
    add_to_cart: acc.add_to_cart + num(r.add_to_cart),
    outbound_clicks: acc.outbound_clicks + num(r.outbound_clicks),
    impressions: acc.impressions + num(r.impressions),
  }), { spend: 0, purchases: 0, purchase_value: 0, add_to_cart: 0, outbound_clicks: 0, impressions: 0 });
  return {
    range: parsed.range,
    ad: {
      meta_ad_id: ad.meta_ad_id,
      ad_name: ad.ad_name,
      effective_status: ad.effective_status,
      created_time: ad.created_time ? ad.created_time.toISOString() : null,
      meta_campaign_id: ad.meta_campaign_id,
      meta_adset_id: ad.meta_adset_id,
      meta_creative_id: ad.meta_creative_id,
      match_status: ad.match_status,
    },
    metrics: deriveMetrics(sums),
    daily: daily.map((r) => ({ date: r.date, ...deriveMetrics(r) })),
  };
}

module.exports = {
  parseFilter,
  adFilterSql,
  REPORTING_TIMEZONE,
  PRESETS,
  DEFAULT_PRESET,
  REACH_FREQUENCY,
  HttpError,
  ymdInZone,
  zonedDayStartUtc,
  addDays,
  listDates,
  resolvePreset,
  previousPeriod,
  parseRangeParams,
  parseAdsQuery,
  deriveMetrics,
  getCoverage,
  getSummary,
  getAds,
  getBestAds,
  parseBestQuery,
  BEST_RANKS,
  getAdDetail,
};
