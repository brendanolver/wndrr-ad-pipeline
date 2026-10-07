// Ad creative preview (video / image / carousel + Meta share link).
//
// Available to admins and to anyone with Planning access: the Core creative plan
// links its evidence here. It returns ONLY the creative and its descriptive
// context (name, product, concept) -- never spend / CPA / reach, which stay on the
// admin-only Meta Performance endpoints. Fetches from Meta are read-only and
// cached per ad (see src/lib/metaAdCreative.js); this route never writes to Meta.
const express = require('express');
const { canAccessModule } = require('../lib/permissions');
const { HttpError } = require('../lib/metaPerformance');
const creatives = require('../lib/metaAdCreative');

const router = express.Router();
const AD_ID_RE = /^[A-Za-z0-9_]{1,64}$/;

router.use(async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'admin' || await canAccessModule(req.user.id, 'planning')) return next();
    return res.status(403).json({ error: 'You do not have access to this module.' });
  } catch (err) { return next(err); }
});

// GET /api/ad-creative/:metaAdId[?refresh=1]
router.get('/:metaAdId', async (req, res, next) => {
  try {
    if (!AD_ID_RE.test(req.params.metaAdId)) throw new HttpError(400, 'Invalid ad id');
    res.json(await creatives.getCreative(req.params.metaAdId, { refresh: req.query.refresh === '1' }));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

module.exports = router;
