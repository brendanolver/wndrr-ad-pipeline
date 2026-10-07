// Pre-2026 archive evidence (admin only). GET endpoints read the LOCAL database only. The single Meta call lives behind the
// explicit POST /pull (a bounded, read-only activity check -- see lib/metaActivityPull.js for exactly what it requests).
const express = require('express');
const { requireAdmin } = require('../lib/permissions');
const archive = require('../lib/metaCreativeArchive');
const pull = require('../lib/metaActivityPull');
const matching = require('../lib/metaAdMatching');
const { HttpError, ymdInZone } = require('../lib/metaPerformance');

const router = express.Router();
router.use(requireAdmin);

function handle(fn) {
  return async (req, res, next) => {
    try { res.json(await fn(req)); } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  };
}

// Evidence status: how far back stored Insights reach, whether the cutoff is provable, the last activity check, and the
// exact request a check would send. Local read only.
router.get('/status', handle(async () => {
  const status = await archive.getStatus();
  return { ...status, pull_request: pull.describeRequest(ymdInZone(new Date())), last_pull: await pull.getStatus() };
}));

// "What would change": the workload as if coverage were proven (a preview -- nothing is archived by asking).
router.get('/preview', handle(async () => {
  const [actual, assumed] = await Promise.all([matching.getWorkload(), matching.getWorkload({ archiveProof: archive.ASSUMED_PROOF })]);
  return {
    cutoff: archive.ARCHIVE_CUTOFF,
    now: { proven: actual.funnel.archive_proven, needs_a_person_now: actual.funnel.actionable_creatives, historical: actual.funnel.historical_creatives, archived: actual.funnel.archived_creatives },
    if_proven: { needs_a_person: assumed.funnel.actionable_creatives, historical: assumed.funnel.historical_creatives, archived: assumed.funnel.archived_creatives },
    note: 'if_proven assumes the period since the cutoff is covered by evidence. Creatives with an ACTIVE ad, an ad created in 2026 (or with an unknown created date), or any stored delivery since the cutoff are never archived either way.',
  };
}));

// EXPLICIT admin action: the bounded Meta activity check. Starts in the background; poll /status.
router.post('/pull', handle(async (req) => pull.startPull({ userId: req.user && req.user.id, force: !!(req.body && req.body.force) })));

module.exports = router;
