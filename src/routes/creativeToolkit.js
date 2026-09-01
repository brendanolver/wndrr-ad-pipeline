const express = require('express');
const { pool } = require('../db');
const { buildContext, buildDevelopConceptsPrompt, buildImproveConceptPrompt, buildReviewPrompt } = require('../lib/creativeToolkitContext');

const router = express.Router();

// GET /api/creative-toolkit/prompt?shoot_plan_item_id=X[&concept_id=Y]
// Builds the whole ChatGPT prompt text server-side (context assembly needs
// live AM/Report Pipeline data the frontend has no access to) so the
// frontend just copies it to the clipboard -- concept_id present means
// "Improve This Concept", absent means "Develop Concepts". Both read the
// concept's last-SAVED state from the DB, which is fine for these two --
// they're reached from the Creative Tools panel, a level removed from the
// fields themselves, so "what's saved" is the only state to reflect.
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

// POST /api/creative-toolkit/review-prompt { shoot_plan_item_id, concept }
// The AI Creative Review section lives directly inside the concept's own
// fields, so unlike /prompt above it builds from whatever's currently
// typed in the modal -- concept is a plain object shaped like a
// creative_assets row (concept_name/angle/execution/hook_variations/
// script_notes/reference_items/talent_requirement/location/props_notes),
// not a DB lookup, so the review always matches what the creator is
// actually looking at, saved or not.
router.post('/review-prompt', async (req, res, next) => {
  try {
    const shootPlanItemId = Number(req.body.shoot_plan_item_id);
    if (!Number.isFinite(shootPlanItemId)) {
      return res.status(400).json({ error: 'shoot_plan_item_id is required' });
    }

    const ctx = await buildContext(shootPlanItemId);
    if (!ctx) return res.status(404).json({ error: 'Shoot plan item not found' });

    const concept = req.body.concept && typeof req.body.concept === 'object' ? req.body.concept : {};
    res.json({ prompt: buildReviewPrompt(ctx, concept) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
