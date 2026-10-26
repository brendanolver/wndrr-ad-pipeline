// Admin-only, read-only-of-Meta endpoints for the Meta performance data
// layer (Phase 1: Meta -> database). No route here creates, modifies, or
// deletes anything in Meta -- every one of them ultimately calls into
// metaSync.js, which only ever issues GET requests. Responses are
// deliberately kept to counts/summaries, never a raw Meta payload, and
// never a credential -- see metaAds.js's stripPagingUrls and metaGet for
// why a paging URL or the token itself can't surface here even
// indirectly.
const express = require('express');
const { requireAdmin } = require('../lib/permissions');
const metaAds = require('../lib/metaAds');
const metaSync = require('../lib/metaSync');
const adMatching = require('../lib/metaAdMatching');
const perf = require('../lib/metaPerformance');

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One place that turns a failed Meta-touching action into an HTTP response
// that is safe to show an admin: a Meta rate limit is a 429 with the fixed
// "existing data is safe" message (+ a retry hint in seconds when Meta or
// the in-process cooldown supplied one); every other MetaApiError already
// carries a sanitised message; anything else is URL-stripped and capped so
// an unexpected error can never put a credential-bearing URL on screen.
function sendMetaError(res, err) {
  if (err && err.code === 'SYNC_IN_PROGRESS') {
    return res.status(409).json({ error: err.message, sync_in_progress: true });
  }
  if (err && err.rateLimited) {
    return res.status(429).json({
      error: err.message,
      rate_limited: true,
      retry_after_seconds: err.retryAfterSeconds || null,
    });
  }
  const message = err && err.safe
    ? err.message
    : String((err && err.message) || 'Meta sync failed').replace(/https?:\/\/\S+/g, '[url removed]').slice(0, 300);
  return res.status(502).json({ error: message });
}

// Account connected / ads discovered / rows stored / most recent sync --
// exactly the checklist the brief asked for, read from meta_sync_runs +
// meta_ads + meta_ad_insights_daily + meta_account_settings. Never queries
// Meta itself -- purely a read of what's already stored locally.
router.get('/status', requireAdmin, async (req, res, next) => {
  try {
    const status = await metaSync.getSyncStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// Read-only: what the deployed process sees for the automatic sync (switch value, credential presence, scheduler state, recent automatic runs).
router.get('/auto-status', requireAdmin, async (req, res, next) => {
  try { res.json(await require('../lib/metaAutoSync').status()); } catch (err) { next(err); }
});

// Routine (lightweight) performance sync: account settings + daily ad-level
// Insights for an explicit range, or the safe default (Sydney today back 2
// days) when no range is given, plus a metadata lookup for ONLY those ads in
// the Insights that have no meta_ads row yet. It never lists or upserts the
// ad inventory -- see /refresh-inventory for that. This is the MANUAL
// fallback; the safe recent-window automatic sync lives in lib/metaAutoSync.js
// and shares the same one-run-at-a-time guard.
router.post('/run', requireAdmin, async (req, res, next) => {
  try {
    if (!metaAds.configured()) {
      return res.status(503).json({ error: 'Meta Ads is not configured (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN missing)' });
    }
    const { since, until } = req.body || {};
    if (since !== undefined && !DATE_RE.test(since)) return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
    if (until !== undefined && !DATE_RE.test(until)) return res.status(400).json({ error: 'until must be YYYY-MM-DD' });
    if ((since && !until) || (until && !since)) return res.status(400).json({ error: 'since and until must be provided together, or both omitted for the default 3-day window' });

    const result = since && until
      ? await metaSync.runSync({ since, until, runType: 'default', userId: req.user.id })
      : await metaSync.runDefaultSync(req.user.id);
    // Best-effort, LOCAL-only follow-up: newly synced ads get their Ad Matching
    // suggestions / auto-match evaluated straight away, so exact structured
    // matches don't wait for someone to open Ad Matching. Never affects (or
    // fails) the sync result; makes no Meta call.
    try {
      result.ad_matching = await adMatching.refreshSuggestions({ scope: '30d' });
    } catch (e) {
      result.ad_matching = { error: 'Ad Matching refresh skipped' };
    }
    res.json(result);
  } catch (err) {
    sendMetaError(res, err);
  }
});

// Full ad-inventory refresh: the heavy, explicit maintenance action,
// deliberately separate from the routine sync above. Pages through every ad
// in the account (~60 Meta calls at ~30k ads) to refresh names/statuses/IDs
// and add historical ads not yet stored. Idempotent upsert; never deletes a
// meta_ads row, never touches match_* (confirmed mappings survive); read-
// only against Meta. Never called by anything automatically.
router.post('/refresh-inventory', requireAdmin, async (req, res) => {
  try {
    if (!metaAds.configured()) {
      return res.status(503).json({ error: 'Meta Ads is not configured (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN missing)' });
    }
    res.json(await metaSync.refreshInventory({ userId: req.user.id }));
  } catch (err) {
    sendMetaError(res, err);
  }
});

// Explicit-range-only historical backfill, chunked into safe windows and
// run sequentially -- never triggered automatically, never a default
// range. Idempotent/resumable: re-posting the same or an overlapping
// range is always safe (every write is an upsert), and a failed run can
// be resumed by re-posting just the remaining range.
router.post('/backfill', requireAdmin, async (req, res, next) => {
  try {
    if (!metaAds.configured()) {
      return res.status(503).json({ error: 'Meta Ads is not configured (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN missing)' });
    }
    const { since, until } = req.body || {};
    if (!since || !DATE_RE.test(since)) return res.status(400).json({ error: 'since (YYYY-MM-DD) is required' });
    if (!until || !DATE_RE.test(until)) return res.status(400).json({ error: 'until (YYYY-MM-DD) is required' });
    if (since > until) return res.status(400).json({ error: 'since must be on or before until' });
    // Optional: rows per Meta page (default 500). The Settings backfill lowers it when Meta says a request is too much data.
    let pageLimit = 500;
    if (req.body.page_limit !== undefined) {
      pageLimit = Number(req.body.page_limit);
      if (!Number.isInteger(pageLimit) || pageLimit < 10 || pageLimit > 500) return res.status(400).json({ error: 'page_limit must be a whole number from 10 to 500' });
    }

    const result = await metaSync.runBackfill({ since, until, userId: req.user.id, pageLimit });
    res.status(result.completed ? 200 : 207).json(result);
  } catch (err) {
    sendMetaError(res, err);
  }
});

// What a history backfill would still have to pull, read from the stored sync history only (NO Meta call): the days of since..until that no complete sync covers
// (never synced, or last synced before the day ended), split into the same 30-day chunks runBackfill uses. The Settings page sends them to POST /backfill one chunk
// at a time, so a long history never rides on one long web request and a stop or a failure leaves everything before it stored. Today is left to the automatic sync.
const MAX_PLAN_DAYS = 800;
router.get('/backfill-plan', requireAdmin, async (req, res, next) => {
  try {
    const { since } = req.query;
    if (!since || !DATE_RE.test(since)) return res.status(400).json({ error: 'since (YYYY-MM-DD) is required' });
    if (req.query.until && !DATE_RE.test(req.query.until)) return res.status(400).json({ error: 'until must be YYYY-MM-DD' });
    const yesterday = perf.addDays(perf.ymdInZone(new Date(), perf.REPORTING_TIMEZONE), -1);
    const until = req.query.until && req.query.until < yesterday ? req.query.until : yesterday;
    if (since > until) return res.status(400).json({ error: 'since must be on or before until (and before today)' });
    if (perf.listDates(since, until).length > MAX_PLAN_DAYS) return res.status(400).json({ error: `Choose at most ${MAX_PLAN_DAYS} days` });
    const cov = await perf.getCoverage({ since, until }, new Date());
    const ranges = [...cov.missing_ranges, ...cov.partial_ranges].sort((a, b) => (a.since < b.since ? -1 : 1));
    const chunks = ranges.flatMap((r) => metaSync.chunkRange(r.since, r.until, metaSync.BACKFILL_CHUNK_DAYS))
      .map((c) => ({ ...c, days: perf.listDates(c.since, c.until).length }));
    res.json({
      since, until, total_days: cov.total_days, missing_days: cov.missing_days, partial_days: cov.partial_days,
      chunks, configured: metaAds.configured(),
    });
  } catch (err) { next(err); }
});

// Production-QA reconciliation aid: every purchase / add-to-cart alias Meta
// returned, totalled over a stored date range, next to the currently
// configured canonical choice (see metaReportingConfig.js). Local read only
// -- never calls Meta.
router.get('/conversion-aliases', requireAdmin, async (req, res, next) => {
  try {
    const { since, until } = req.query;
    if (!since || !DATE_RE.test(since)) return res.status(400).json({ error: 'since (YYYY-MM-DD) is required' });
    if (!until || !DATE_RE.test(until)) return res.status(400).json({ error: 'until (YYYY-MM-DD) is required' });
    res.json(await metaSync.conversionAliasTotals({ since, until }));
  } catch (err) {
    next(err);
  }
});

// Read-only inventory report over the LOCAL meta_ads table (never calls Meta,
// never writes) -- see metaSync.adInventoryDiagnostics.
router.get('/ad-inventory', requireAdmin, async (req, res, next) => {
  try {
    res.json(await metaSync.adInventoryDiagnostics());
  } catch (err) {
    next(err);
  }
});

// After changing the canonical action types in metaReportingConfig.js (or
// its env vars), recomputes the derived conversion columns for stored rows
// from their own stored raw action JSON. No Meta call, no schema change.
router.post('/rederive-conversions', requireAdmin, async (req, res, next) => {
  try {
    const { since, until } = req.body || {};
    if (!since || !DATE_RE.test(since)) return res.status(400).json({ error: 'since (YYYY-MM-DD) is required' });
    if (!until || !DATE_RE.test(until)) return res.status(400).json({ error: 'until (YYYY-MM-DD) is required' });
    if (since > until) return res.status(400).json({ error: 'since must be on or before until' });
    res.json(await metaSync.rederiveConversions({ since, until }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
