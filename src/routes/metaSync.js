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

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One place that turns a failed Meta-touching action into an HTTP response
// that is safe to show an admin: a Meta rate limit is a 429 with the fixed
// "existing data is safe" message (+ a retry hint in seconds when Meta or
// the in-process cooldown supplied one); every other MetaApiError already
// carries a sanitised message; anything else is URL-stripped and capped so
// an unexpected error can never put a credential-bearing URL on screen.
function sendMetaError(res, err) {
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

// Routine (lightweight) performance sync: account settings + daily ad-level
// Insights for an explicit range, or the safe default (Sydney today back 2
// days) when no range is given, plus a metadata lookup for ONLY those ads in
// the Insights that have no meta_ads row yet. It never lists or upserts the
// ad inventory -- see /refresh-inventory for that. Always admin-triggered --
// nothing calls this on a schedule or at server startup.
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

    const result = await metaSync.runBackfill({ since, until, userId: req.user.id });
    res.status(result.completed ? 200 : 207).json(result);
  } catch (err) {
    sendMetaError(res, err);
  }
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
