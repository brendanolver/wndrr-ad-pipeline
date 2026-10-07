// Meta Performance -- admin-only endpoints. Every GET reads the LOCAL Meta
// tables only, so the page works from stored data alone (even if Meta is
// down) and a page view can never spend a Meta API call or touch a
// credential. Only the POSTs below make (read-only) Meta calls: /reach/load,
// /refresh (stale additive sync / exact range reach / campaign names; page-triggered
// calls are gated by the same META_AUTO_SYNC switch as the scheduler) and
// /campaigns/refresh. See lib/metaFreshness.js and metaRangeReach.js.
// See src/lib/metaPerformance.js for the aggregation rules.
const express = require('express');
const { requireAdmin } = require('../lib/permissions');
const perf = require('../lib/metaPerformance');
const reachLib = require('../lib/metaRangeReach');
const freshness = require('../lib/metaFreshness');
const campaigns = require('../lib/metaCampaigns');

const router = express.Router();
router.use(requireAdmin);

const AD_ID_RE = /^[A-Za-z0-9_]{1,64}$/;

function handle(fn) {
  return async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof perf.HttpError) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  };
}

// Headline KPIs + coverage/freshness (+ optional previous-period compare).
// GET /api/meta-performance/summary?preset=last_7|since=&until=&compare=1
router.get('/summary', handle((req) => perf.getSummary(perf.parseRangeParams(req.query), new Date(), perf.parseFilter(req.query))));

// One page of ads that had activity in the range.
// GET /api/meta-performance/ads?preset=&since=&until=&q=&status=all|active|paused|other
//     &sort=&dir=asc|desc&page=&page_size=
router.get('/ads', handle((req) => perf.getAds(perf.parseRangeParams(req.query), req.query)));

// Detail for one ad over the range, with its daily breakdown.
// GET /api/meta-performance/ads/:metaAdId?preset=|since=&until=
router.get('/ads/:metaAdId', handle((req) => {
  if (!AD_ID_RE.test(req.params.metaAdId)) throw new perf.HttpError(400, 'Invalid ad id');
  return perf.getAdDetail(req.params.metaAdId, perf.parseRangeParams(req.query));
}));

// Range-level Reach / Frequency (unique people: never summed from daily rows).
// GET  /api/meta-performance/reach?preset=|since=&until=   -> cache status (DB only, no Meta call)
// POST /api/meta-performance/reach/load {preset|since,until, force?} -> start an ON-DEMAND, read-only
//      Meta pull for exactly that range (background); repeat while loading/fresh makes no Meta call.
router.get('/reach', handle((req) => reachLib.getStatus(perf.parseRangeParams(req.query).range)));
router.post('/reach/load', handle((req) => {
  const parsed = perf.parseRangeParams(req.body || {});
  return reachLib.startPull(parsed.range, { userId: req.user && req.user.id, force: !!(req.body && req.body.force) });
}));

// Campaign / funnel context. GET /campaigns?preset|since,until -> campaigns that ran in the period (name, funnel, ads, spend)
// for the filter dropdowns. GET /campaign-patterns -> how the stored campaign names are built (for defining the real mapping).
// POST /campaigns/refresh -> one explicit read-only Meta read of the campaign list.
router.get('/campaigns', handle(async (req) => {
  const parsed = perf.parseRangeParams(req.query);
  const list = await campaigns.listForRange(parsed.range);
  const f = await campaigns.lastFetchedAt();
  return { range: parsed.range, ...list, names_fetched_at: f.at ? f.at.toISOString() : null };
}));
router.get('/campaign-patterns', handle(() => campaigns.patternCensus()));
router.post('/campaigns/refresh', handle(async () => ({ ...(await campaigns.refreshCampaigns()) })));

// Automatic freshness. GET /freshness?preset|since,until -> stored/cached ages + what is stale + whether automatic refresh is
// allowed (DB only, no Meta call). POST /refresh {preset|since,until, auto?, force?} -> start whatever is stale in the background
// (auto: page-triggered, needs META_AUTO_SYNC on; force: the manual "Refresh now" button). See lib/metaFreshness.js.
router.get('/freshness', handle((req) => freshness.getFreshness(perf.parseRangeParams(req.query).range)));
router.post('/refresh', handle((req) => {
  const parsed = perf.parseRangeParams(req.body || {});
  return freshness.startRefresh(parsed.range, { userId: req.user && req.user.id, auto: !!(req.body && req.body.auto), force: !!(req.body && req.body.force) });
}));

module.exports = router;
