const express = require('express');
const { listDropsWithSummary, getDropDetail } = require('../lib/dropsData');

// Read-only routes for other internal WNDRR apps to consume directly --
// currently just TUESDAY's Marketing > Drops tab, which mirrors this app's
// own Upcoming Drops page. Gated by requireIntegrationToken in server.js
// (a shared static Bearer token, not a session cookie), not requireAuth.
// Deliberately view-only: no POST/PUT/DELETE here. This app stays the one
// place drops/styles/creative assets actually get managed -- TUESDAY only
// ever reads.
const router = express.Router();

router.get('/drops', async (req, res, next) => {
  try {
    res.json(await listDropsWithSummary());
  } catch (err) {
    next(err);
  }
});

router.get('/drops/:id', async (req, res, next) => {
  try {
    const detail = await getDropDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Drop not found' });
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
