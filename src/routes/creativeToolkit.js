const express = require('express');
const { pool } = require('../db');
const { buildContext, buildDevelopConceptsPrompt, buildImproveConceptPrompt } = require('../lib/creativeToolkitContext');

const router = express.Router();

// GET /api/creative-toolkit/prompt?shoot_plan_item_id=X[&concept_id=Y]
// Builds the whole ChatGPT prompt text server-side (context assembly needs
// live AM/Report Pipeline data the frontend has no access to) so the
// frontend just copies it to the clipboard -- concept_id present means
// "Improve This Concept", absent means "Develop Concepts".
router.get('/prompt', async (req, res, next) => {
  try {
    const shootPlanItemId = Number(req.query.shoot_plan_item_id);
    if (!Number.isFinite(shootPlanItemId)) {
      return res.status(400).json({ error: 'shoot_plan_item_id is required' });
    }

    const ctx = await buildContext(shootPlanItemId);
    if (!ctx) return res.status(404).json({ error: 'Shoot plan item not found' });

    const conceptId = req.query.concept_id;
    if (conceptId) {
      const conceptResult = await pool.query('SELECT * FROM creative_assets WHERE id = $1', [conceptId]);
      if (!conceptResult.rows.length) return res.status(404).json({ error: 'Concept not found' });
      return res.json({ prompt: buildImproveConceptPrompt(ctx, conceptResult.rows[0]) });
    }

    res.json({ prompt: buildDevelopConceptsPrompt(ctx) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
