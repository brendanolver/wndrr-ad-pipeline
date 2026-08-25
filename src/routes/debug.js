const express = require('express');
const apparelmagic = require('../lib/apparelmagic');

const router = express.Router();

// Whether the AM cache (stock/catalogue/on-order) has data yet, and whether
// a fetch is currently in flight -- useful to tell "genuinely no matching
// styles" apart from "still doing the first crawl since deploy."
router.get('/am/status', (req, res) => {
  res.json({ configured: apparelmagic.configured(), cache: apparelmagic.getAmCacheStatus() });
});

// Diagnostic only -- returns a raw ApparelMagic product record so we can see
// real field names (e.g. images) instead of guessing. Requires auth like
// everything else; not linked from the UI.
router.get('/am/product/:styleCode', async (req, res, next) => {
  try {
    if (!apparelmagic.configured()) {
      return res.status(503).json({ error: 'ApparelMagic is not configured' });
    }
    const result = await apparelmagic.rawRequest('products', {
      style_number: req.params.styleCode,
      // ApparelMagic rejects page sizes below 10 ("must be between 10 and 1000").
      'pagination[page_size]': 10,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
