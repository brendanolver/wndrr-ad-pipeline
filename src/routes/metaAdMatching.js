// Meta Ad Matching V1 -- admin-only endpoints over the LOCAL database.
// Nothing here imports metaAds.js or issues a Meta request: opening the
// queue, searching, suggesting, confirming and editing a classification are
// all local reads/writes (Meta synchronisation is a separate, explicit job).
// See src/lib/metaAdMatching.js for the model and the confirmed-mapping
// protections.
const express = require('express');
const { requireAdmin } = require('../lib/permissions');
const matching = require('../lib/metaAdMatching');
const { HttpError } = require('../lib/metaPerformance');

const router = express.Router();
router.use(requireAdmin);

const AD_ID_RE = /^[A-Za-z0-9_]{1,64}$/;

function handle(fn) {
  return async (req, res, next) => {
    try {
      const result = await fn(req);
      if (result === undefined) return res.status(204).end();
      return res.json(result);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  };
}
function adId(req) {
  if (!AD_ID_RE.test(req.params.metaAdId)) throw new HttpError(400, 'Invalid ad id');
  return req.params.metaAdId;
}

// Queue: recent-activity ads first (default scope = active in the last 30
// days), filterable and searchable. GET /queue?scope=30d|90d|all
//   &filter=needs|unmatched|suggested|confirmed|not_product_specific|excluded|all
//   &q=&page=&page_size=
router.get('/queue', handle((req) => matching.getQueue(req.query)));

// Selector vocabularies (products / concepts / creative styles / creators).
router.get('/options', handle(() => matching.listOptions()));

// Ad Setup search for the Link-to-Ad-Setup selector, and the values an Ad
// Setup would pre-fill (never auto-applied).
router.get('/ad-setups', handle((req) => matching.searchAdSetups(req.query.q)));
router.get('/ad-setups/:id/prefill', handle((req) => matching.adSetupPrefill(req.params.id)));

// (Re)compute deterministic suggestions for non-confirmed ads. Suggestions
// are only ever proposals -- a confirmed ad is skipped outright.
router.post('/suggest', handle((req) => matching.refreshSuggestions({
  scope: (req.body && req.body.scope) || '30d',
  pendingOnly: !(req.body && req.body.all === true),
  limit: req.body && req.body.limit,
})));

// Backlog reprocess: every non-confirmed ad still on an older rules version, in
// the background, resumable. POST starts (returns at once), GET reports
// progress + the remaining-stale truth from the database, POST /stop asks it
// to finish its current ad and stop. Local database only.
router.get('/reprocess-backlog', handle(() => matching.getBacklogStatus()));
router.post('/reprocess-backlog', handle(() => matching.startBacklogReprocess()));
router.post('/reprocess-backlog/stop', handle(() => matching.stopBacklogReprocess()));

// Workspace for one ad: Meta evidence + current classification + suggestions.
router.get('/ads/:metaAdId', handle((req) => matching.getAdWorkspace(adId(req), { refresh: req.query.refresh !== '0' })));

// Human actions.
router.post('/ads/:metaAdId/confirm', handle((req) => matching.confirmMapping(adId(req), req.body, req.user && req.user.id)));
router.post('/ads/:metaAdId/skip', handle((req) => matching.skipAd(adId(req), req.user && req.user.id)));
router.post('/ads/:metaAdId/exclude', handle((req) => matching.setExcluded(adId(req), true, req.body && req.body.reason, req.user && req.user.id)));
router.post('/ads/:metaAdId/include', handle((req) => matching.setExcluded(adId(req), false, null, req.user && req.user.id)));
router.delete('/ads/:metaAdId/mapping', handle((req) => matching.clearMapping(adId(req))));

// Foundation for later creative-intelligence queries: stored Meta
// performance grouped through the CONFIRMED classification (read-only).
// GET /performance?by=product|concept|creator|creative_style|ad_setup
//   &preset=|since=&until= [&product_code=&concept=&creator=&creative_style_id=]
router.get('/performance', handle((req) => matching.performanceBy(req.query)));

module.exports = router;
