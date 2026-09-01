const express = require('express');
const { pool } = require('../db');
const { buildContext, buildDevelopConceptsPrompt, buildImproveConceptPrompt, buildReviewPrompt } = require('../lib/creativeToolkitContext');

const router = express.Router();

// Shared by both prompt routes below -- resolves a concept's selected
// Customer Avatar (if any) into the full customer_avatars row the prompt
// builders need (name + all four strategic fields), so the prompt can
// carry that context rather than just an id. Returns null when the
// concept has no saved avatar selected (either blank, or using
// "+ Other / New Avatar", which carries its own description inline on
// the concept row instead).
async function resolveAvatar(customerAvatarId) {
  if (!customerAvatarId) return null;
  const result = await pool.query('SELECT * FROM customer_avatars WHERE id = $1', [customerAvatarId]);
  return result.rows[0] || null;
}

// GET /api/creative-toolkit/prompt?shoot_plan_item_id=X[&concept_id=Y]
// Builds the whole ChatGPT prompt text server-side (context assembly needs
// live AM/Report Pipeline data the frontend has no access to) so the
// frontend just copies it to the clipboard -- concept_id present means
// "Develop This Concept", absent means "Develop Concepts". Both read the
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
      const concept = conceptResult.rows[0];
      const avatar = await resolveAvatar(concept.customer_avatar_id);
      return res.json({ prompt: buildImproveConceptPrompt(ctx, concept, avatar) });
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
// script_notes/reference_items/talent_requirement/location/props_notes/
// customer_avatar_id/custom_avatar_description/avatar_why_care), not a DB
// lookup, so the review always matches what the creator is actually
// looking at, saved or not. customer_avatar_id (if present) still needs
// its full avatar row resolved from the DB, since the frontend only holds
// the id/name locally, not every strategic field.
router.post('/review-prompt', async (req, res, next) => {
  try {
    const shootPlanItemId = Number(req.body.shoot_plan_item_id);
    if (!Number.isFinite(shootPlanItemId)) {
      return res.status(400).json({ error: 'shoot_plan_item_id is required' });
    }

    const ctx = await buildContext(shootPlanItemId);
    if (!ctx) return res.status(404).json({ error: 'Shoot plan item not found' });

    const concept = req.body.concept && typeof req.body.concept === 'object' ? req.body.concept : {};
    const avatar = await resolveAvatar(concept.customer_avatar_id);
    res.json({ prompt: buildReviewPrompt(ctx, concept, avatar) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
