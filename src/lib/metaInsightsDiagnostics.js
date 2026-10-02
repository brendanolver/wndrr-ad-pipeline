// TEMPORARY, read-only diagnostic for the "Meta Insights validation" round
// -- not part of the product, not referenced by anything except the one
// debug route that calls it. Safe to delete entirely (this file + its one
// route + require line in debug.js) once the real analytics architecture
// is decided and built.
//
// Exercises the EXISTING server-side Meta credentials (metaAds.js's
// configured()/metaGet(), the same META_AD_ACCOUNT_ID / META_ACCESS_TOKEN
// the live-ad-coverage feature already uses) against a handful of small,
// read-only Graph API GET calls, and reports back exactly what each one
// returned or failed with. Every call here is a GET against /insights,
// the account object, or /ads -- nothing here can create, modify, or
// delete anything in Meta, and nothing here ever touches, logs, or
// returns the access token itself (metaGet keeps it fully encapsulated in
// metaAds.js; Meta's own error bodies never echo back the request URL).
//
// Field names below are DELIBERATELY not assumed to be correct for this
// account -- each probe is grouped so a single invalid/unsupported field
// only fails its own group, and every group reports its raw Meta
// response (or raw Meta error) rather than a pass/fail guess, so the real
// action_type strings, video fields, and any attribution behaviour can be
// read directly off this account's own data.
const { configured, metaGet, accountPath } = require('./metaAds');

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function windowEndingDaysAgo(daysAgo, spanDays = 1) {
  const until = new Date();
  until.setUTCHours(0, 0, 0, 0);
  until.setUTCDate(until.getUTCDate() - daysAgo);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (spanDays - 1));
  return { since: fmtDate(since), until: fmtDate(until) };
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, threw: true, error: err.message };
  }
}

// 1. Account-level fields -- split from the attribution probe below so an
// unsupported field on one side never blocks the other.
async function testAccountCore() {
  const result = await metaGet(accountPath(), {
    fields: 'name,currency,timezone_name,timezone_offset_hours_utc,account_status',
  });
  return { status: result.status, data: result.data };
}

async function testAccountAttributionSpec() {
  const result = await metaGet(accountPath(), { fields: 'attribution_spec' });
  return { status: result.status, data: result.data };
}

// 2. Smallest possible Insights read -- the direct "does ads_read actually
// cover Insights" test. One field, one day, one row.
//
// Security fix (post-validation): this used to return the raw `result.data`
// wholesale, which for a list endpoint like /insights is
// `{ data: [...], paging: { cursors, next, previous } }` -- paging.next/
// previous are full URLs with access_token=... embedded by Meta. That's
// the exact leak this round's diagnostic caused. metaRequest now strips
// paging.next/previous for every call (see metaAds.js's stripPagingUrls),
// but this probe no longer echoes the raw payload at all regardless --
// only the status and the row(s) actually needed to answer the question.
async function testInsightsPermission() {
  const result = await metaGet(`${accountPath()}/insights`, {
    level: 'ad',
    fields: 'impressions',
    date_preset: 'yesterday',
    limit: '1',
  });
  return {
    status: result.status,
    rows_returned: result.status === 200 ? (result.data?.data || []).length : 0,
    sample_row: result.status === 200 ? (result.data?.data || [])[0] : undefined,
    error: result.status !== 200 ? result.data : undefined,
  };
}

// 3. Daily grain -- a real time_increment=1 pull over a few days, checking
// that distinct (ad_id, date_start) pairs equal the row count (i.e. one
// row per ad per day, not pre-aggregated).
async function testDailyGrain() {
  const range = windowEndingDaysAgo(2, 3); // a 3-day window ending 2 days ago
  const result = await metaGet(`${accountPath()}/insights`, {
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify(range),
    fields: 'ad_id,ad_name,impressions',
    limit: '100',
  });
  if (result.status !== 200) {
    return { status: result.status, range, error: result.data };
  }
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  const distinctPairs = new Set(rows.map((r) => `${r.ad_id}|${r.date_start}`)).size;
  return {
    status: result.status,
    range,
    rows_returned: rows.length,
    distinct_ad_day_pairs: distinctPairs,
    one_row_per_ad_per_day: rows.length === distinctPairs,
    sample_rows: rows.slice(0, 5),
  };
}

// 4. Metric availability, grouped so one bad field name can't sink the
// others. date_preset: last_30d to maximise the chance of non-empty rows
// (a 200 with zero rows still proves the field is queryable; it just means
// nothing delivered in that window).
const METRIC_GROUPS = {
  delivery: ['impressions', 'reach', 'frequency', 'spend'],
  outbound_clicks: ['outbound_clicks', 'outbound_clicks_ctr'],
  conversions: ['actions', 'action_values', 'cost_per_action_type'],
  video: [
    'video_play_actions', 'video_thruplay_watched_actions',
    'video_p25_watched_actions', 'video_p50_watched_actions',
    'video_p75_watched_actions', 'video_p95_watched_actions', 'video_p100_watched_actions',
  ],
};

async function testMetricGroups() {
  const out = {};
  for (const [groupName, fields] of Object.entries(METRIC_GROUPS)) {
    out[groupName] = await safeCall(async () => {
      const result = await metaGet(`${accountPath()}/insights`, {
        level: 'ad',
        fields: fields.join(','),
        date_preset: 'last_30d',
        limit: '10',
      });
      const rows = result.status === 200 && Array.isArray(result.data?.data) ? result.data.data : [];
      return {
        status: result.status,
        fields_requested: fields,
        rows_returned: rows.length,
        sample_rows: rows.slice(0, 3),
        error: result.status !== 200 ? result.data : undefined,
      };
    });
  }
  return out;
}

// 5. Attribution behaviour -- compares an Insights pull with no explicit
// attribution window (whatever the account default is) against one with
// an explicit window requested, plus a standalone probe of the
// use_account_attribution_setting field. Reports raw results for all
// three; does NOT pick or lock a model.
async function testAttribution() {
  const common = { level: 'ad', fields: 'actions', date_preset: 'last_30d', limit: '5' };

  const defaultWindow = await safeCall(async () => {
    const result = await metaGet(`${accountPath()}/insights`, common);
    return {
      status: result.status,
      sample_rows: result.status === 200 ? (result.data?.data || []).slice(0, 2) : undefined,
      error: result.status !== 200 ? result.data : undefined,
    };
  });

  const explicitWindow = await safeCall(async () => {
    const result = await metaGet(`${accountPath()}/insights`, {
      ...common,
      action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
    });
    return {
      status: result.status,
      sample_rows: result.status === 200 ? (result.data?.data || []).slice(0, 2) : undefined,
      error: result.status !== 200 ? result.data : undefined,
    };
  });

  const useAccountSettingField = await safeCall(async () => {
    const result = await metaGet(`${accountPath()}/insights`, {
      level: 'ad', fields: 'use_account_attribution_setting', date_preset: 'last_7d', limit: '1',
    });
    return { status: result.status, data: result.data };
  });

  return { default_window: defaultWindow, explicit_7d_click_1d_view: explicitWindow, use_account_attribution_setting_field: useAccountSettingField };
}

// 6. Historical depth -- a handful of small, strategically-spaced single-
// day windows rather than any bulk pull. A 200 with zero rows means the
// call succeeded but nothing delivered that day (NOT a depth limit); only
// a non-200 response indicates the API actually refused the range.
async function testHistoricalDepth() {
  const probes = [
    { label: '7 days ago', daysAgo: 7 },
    { label: '90 days ago', daysAgo: 90 },
    { label: '365 days ago', daysAgo: 365 },
    { label: '730 days ago (~2 years)', daysAgo: 730 },
  ];
  const out = [];
  for (const probe of probes) {
    const range = windowEndingDaysAgo(probe.daysAgo, 1);
    out.push(await safeCall(async () => {
      const result = await metaGet(`${accountPath()}/insights`, {
        level: 'ad', time_increment: '1', fields: 'impressions',
        time_range: JSON.stringify(range), limit: '5',
      });
      return {
        label: probe.label,
        range,
        status: result.status,
        rows_returned: result.status === 200 ? (result.data?.data || []).length : 0,
        error: result.status !== 200 ? result.data : undefined,
      };
    }));
  }
  return out;
}

// 7. A small sample of real ads with their stable Meta IDs -- to confirm
// ID-based linking is viable regardless of how the name-parsing pipeline
// performs. Does not touch, remap, or write anything.
async function testAdIdentitySample() {
  const result = await metaGet(`${accountPath()}/ads`, {
    fields: 'id,name,effective_status,campaign_id,adset_id,creative{id},created_time',
    limit: '10',
  });
  return {
    status: result.status,
    data: result.status === 200 ? (result.data?.data || []) : result.data,
  };
}

async function runFullValidation() {
  if (!configured()) {
    return { configured: false };
  }
  const [
    accountCore, accountAttributionSpec, insightsPermission, dailyGrain,
    metricGroups, attribution, historicalDepth, adIdentitySample,
  ] = await Promise.all([
    safeCall(testAccountCore),
    safeCall(testAccountAttributionSpec),
    safeCall(testInsightsPermission),
    safeCall(testDailyGrain),
    safeCall(testMetricGroups),
    safeCall(testAttribution),
    safeCall(testHistoricalDepth),
    safeCall(testAdIdentitySample),
  ]);
  return {
    configured: true,
    account_core: accountCore,
    account_attribution_spec: accountAttributionSpec,
    insights_permission: insightsPermission,
    daily_grain: dailyGrain,
    metric_groups: metricGroups,
    attribution,
    historical_depth: historicalDepth,
    ad_identity_sample: adIdentitySample,
  };
}

module.exports = { runFullValidation };
