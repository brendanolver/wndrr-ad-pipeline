const express = require('express');
const reportPipeline = require('../lib/reportPipeline');

const router = express.Router();

// Category-level "this month to date vs the same days last year" -- the
// comparison shown on the Core Shoot Planning page, ported from demand-v2's
// own Sales Cadence view (its "LY MTD vs THIS MTD" column). Degrades
// gracefully to an empty list when the Report Pipeline isn't configured,
// same pattern as High Stock's own use of this same data source.
router.get('/', async (req, res, next) => {
  try {
    if (!reportPipeline.configured()) {
      return res.json({ configured: false, as_of: null, period_start: null, categories: [], total: null });
    }
    const cadence = await reportPipeline.getCategorySalesCadence();
    res.json({ configured: true, ...cadence });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
