// Meta Performance V1 -- admin-only, READ-ONLY endpoints over the local
// Meta tables. Nothing here imports metaAds.js or issues any Meta request,
// so the page works from stored data alone (even if Meta is down) and a
// page view can never spend a Meta API call or touch a credential. See
// src/lib/metaPerformance.js for the aggregation rules.
const express = require('express');
const { requireAdmin } = require('../lib/permissions');
const perf = require('../lib/metaPerformance');

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
router.get('/summary', handle((req) => perf.getSummary(perf.parseRangeParams(req.query))));

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

module.exports = router;
