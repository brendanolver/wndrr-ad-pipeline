const express = require('express');
const apparelmagic = require('../lib/apparelmagic');

const router = express.Router();

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
      'pagination[page_size]': 5,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
