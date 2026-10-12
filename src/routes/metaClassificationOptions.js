// Settings -> Creative Classification (admin-only): add / rename / merge / hide the options Ad Matching offers for Concept, Creator and
// Creative Style. A change that rewrites classifications is previewed (read-only) and applied only with an explicit confirmation of that
// preview. Every change is audited. Local database only. See src/lib/metaClassificationOptions.js.
const express = require('express');
const { requireAdmin } = require('../lib/permissions');
const options = require('../lib/metaClassificationOptions');
const { HttpError } = require('../lib/metaPerformance');

const router = express.Router();
router.use(requireAdmin);

function handle(fn) {
  return async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code || undefined });
      return next(err);
    }
  };
}

// GET /api/meta-classification-options/history
router.get('/history', handle((req) => options.history(parseInt(req.query.limit, 10) || 40)));
// GET /api/meta-classification-options/:kind   (kind = concept | creator | style) -> every option with its status and usage counts
router.get('/:kind', handle((req) => options.listOptions(req.params.kind)));
// POST /:kind/add  { name, media_type? (styles) }
router.post('/:kind/add', handle((req) => options.addOption(req.params.kind, req.body, req.user && req.user.id)));
// POST /:kind/preview { action: rename|merge|deactivate|reactivate, source, target?, new_name? }  -> READ-ONLY plan (counts, sample, effects, fingerprint)
router.post('/:kind/preview', handle((req) => options.preview(req.params.kind, req.body)));
// POST /:kind/apply { ...the same fields, fingerprint, confirm: true } -> one transaction; refused if the records changed since the preview
router.post('/:kind/apply', handle((req) => options.apply(req.params.kind, req.body, req.user && req.user.id)));

module.exports = router;
