// "Move Back" -- a controlled, admin-only QA/testing action that sends an
// EXISTING concept back one pipeline stage: Ad Setup -> Approved ...
// Concept Dev -> Tuesday Review -> Shooting -> Editing -> Final Approval ->
// Ad Setup -> Approved, in reverse. It never creates a new concept, never
// duplicates shoot_schedule/final_edits/ad_setups, and never resets a
// batch number or sale sequence number -- those columns are simply never
// touched here. Current stage is always DETECTED from the concept's own
// real state (never trusted from the client), so the same two endpoints
// work from every screen: GET .../preview for the confirmation modal's
// copy, POST to actually perform the one valid backward move.
const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../lib/permissions');

const router = express.Router();

const STAGE_LABELS = {
  'concept-dev': 'Concept Dev',
  'tuesday-review': 'Tuesday Review',
  shooting: 'Shooting',
  editing: 'Editing',
  'final-approval': 'Final Approval',
  'ad-setup': 'Ad Setup',
  approved: 'Approved',
};

// Reads every field Move Back needs to decide, from the furthest-along
// stage backward -- first match wins, since a concept in a later stage
// still carries the (untouched) flags of every earlier stage it already
// passed through.
async function loadMoveBackState(creativeAssetId) {
  const conceptResult = await pool.query(
    `SELECT ca.*, ss.id AS shoot_schedule_id, ss.ready_for_editing, ss.status AS shoot_status
     FROM creative_assets ca
     LEFT JOIN shoot_schedule ss ON ss.creative_asset_id = ca.id
     WHERE ca.id = $1`,
    [creativeAssetId]
  );
  if (!conceptResult.rows.length) return null;
  const concept = conceptResult.rows[0];

  const adSetupsResult = await pool.query(
    `SELECT status FROM ad_setups WHERE creative_asset_id = $1`,
    [creativeAssetId]
  );
  const adSetups = adSetupsResult.rows;
  const hasApprovedAdSetup = adSetups.some((r) => r.status === 'approved') || !!concept.ad_setup_approved_at;

  // "Currently at Ad Setup" is decided by final_approval_status itself
  // (the real, current state field -- same thing the Ad Setup board query
  // gates on), never by whether ad_setups ROWS merely exist: those rows
  // are deliberately never deleted by a Move Back (see the 'ad-setup'
  // branch below), so after moving back to Final Approval they're still
  // sitting in the table, reused rather than duplicated next time --  but
  // that must NOT make this concept look like it's still at Ad Setup.
  let currentStage = null;
  if (hasApprovedAdSetup) currentStage = 'approved';
  else if (concept.final_approval_status === 'approved') currentStage = 'ad-setup';
  else if (concept.editing_submitted_at) currentStage = 'final-approval';
  else if (concept.ready_for_editing) currentStage = 'editing';
  else if (concept.shoot_schedule_id) currentStage = 'shooting';
  else if (concept.concept_dev_status === 'ready_for_review') currentStage = 'tuesday-review';
  else currentStage = 'concept-dev';

  const TARGET_FOR = {
    approved: 'ad-setup',
    'ad-setup': 'final-approval',
    'final-approval': 'editing',
    editing: 'shooting',
    shooting: 'tuesday-review',
    'tuesday-review': 'concept-dev',
    'concept-dev': null,
  };

  return { concept, currentStage, targetStage: TARGET_FOR[currentStage] };
}

router.get('/:creativeAssetId/preview', requireAdmin, async (req, res, next) => {
  try {
    const state = await loadMoveBackState(req.params.creativeAssetId);
    if (!state) return res.status(404).json({ error: 'Concept not found' });
    if (!state.targetStage) {
      return res.status(400).json({ error: 'This concept is already at Concept Dev -- there is no earlier stage to move it back to.' });
    }
    res.json({
      concept_name: state.concept.concept_name,
      current_stage: state.currentStage,
      current_stage_label: STAGE_LABELS[state.currentStage],
      target_stage: state.targetStage,
      target_stage_label: STAGE_LABELS[state.targetStage],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:creativeAssetId', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const state = await loadMoveBackState(req.params.creativeAssetId);
    if (!state) return res.status(404).json({ error: 'Concept not found' });
    if (!state.targetStage) {
      return res.status(400).json({ error: 'This concept is already at Concept Dev -- there is no earlier stage to move it back to.' });
    }
    const id = state.concept.id;

    await client.query('BEGIN');

    if (state.currentStage === 'approved') {
      // Approved -> Ad Setup: un-approve every ad_setups row this concept
      // has (never delete/replace any of them -- batch/sale-sequence stay
      // exactly as assigned), and clear the concept-level approved stamp.
      await client.query(`UPDATE ad_setups SET status = 'draft', updated_at = now() WHERE creative_asset_id = $1 AND status = 'approved'`, [id]);
      await client.query(
        `UPDATE creative_assets SET ad_setup_approved_at = NULL, ad_setup_approved_by_user_id = NULL, updated_at = now() WHERE id = $1`,
        [id]
      );
    } else if (state.currentStage === 'ad-setup') {
      // Ad Setup -> Final Approval: the concept's existing ad_setups rows
      // are left completely untouched (still status = 'draft', still
      // carrying whatever naming/copy/batch was already filled in) -- see
      // the board query's fe.is_active/final_approval_status guard, which
      // is what actually hides them from the Ad Setup tab while the
      // concept sits one stage earlier. Re-approving later hits
      // createAdSetupsForConcept's ON CONFLICT (final_edit_id) DO NOTHING,
      // so these exact rows are reused, never duplicated, never
      // renumbered.
      await client.query(
        `UPDATE creative_assets SET final_approval_status = 'pending', final_approved_at = NULL, final_approved_by_user_id = NULL, updated_at = now() WHERE id = $1`,
        [id]
      );
    } else if (state.currentStage === 'final-approval') {
      // Final Approval -> Editing: the exact same DB effect Request
      // Changes already uses (see finalApproval.js) -- drops the concept
      // out of the Final Approval queue and back into Editing's own
      // In Progress/Edited view, same final_edits rows, nothing cleared
      // on them.
      await client.query(
        `UPDATE creative_assets SET editing_submitted_at = NULL, editing_submitted_by_user_id = NULL, updated_at = now() WHERE id = $1`,
        [id]
      );
    } else if (state.currentStage === 'editing') {
      // Editing -> Shooting: the exact same shoot_schedule reset
      // POST /shooting/:id/unmark-shot already uses. final_edits are left
      // completely alone here -- reconciliation only happens when Tuesday
      // Review is re-approved (see conceptDevelopment.js), never at the
      // moment of moving back.
      await client.query(
        `UPDATE shoot_schedule SET
           status = 'scheduled', shot_at = NULL, ready_for_editing = false,
           editing_original_week_start = NULL, editing_week_start = NULL, editing_day = NULL,
           updated_at = now()
         WHERE creative_asset_id = $1`,
        [id]
      );
    } else if (state.currentStage === 'shooting') {
      // Shooting -> Tuesday Review: concept_dev_status flips back to
      // ready_for_review so it reappears in Tuesday Review's queue with
      // its existing hooks. The shoot_schedule row is deleted rather than
      // kept paused -- it's pure scheduling placement (day/week/shot
      // status), never the Creator assignment (that's
      // creative_assets.filming_owner, untouched here) or any creative
      // content, and ensureShootScheduleForApprovedConcept's own
      // ON CONFLICT DO NOTHING regenerates exactly one fresh row,
      // unscheduled, the moment this concept is re-approved -- so this can
      // never produce two shoot_schedule rows for the same concept.
      await client.query(`DELETE FROM shoot_schedule WHERE creative_asset_id = $1`, [id]);
      const historyEntry = {
        action: 'moved_back', from_stage: 'shooting', to_stage: 'tuesday-review',
        moved_at: new Date().toISOString(), moved_by: req.user.name, moved_by_user_id: req.user.id,
      };
      await client.query(
        `UPDATE creative_assets SET concept_dev_status = 'ready_for_review', review_history = review_history || $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify([historyEntry]), id]
      );
    } else if (state.currentStage === 'tuesday-review') {
      // Tuesday Review -> Concept Dev: back to an editable draft. Nothing
      // on the concept's own fields (angle/hooks/shots/etc.) is touched --
      // it's exactly what was there, just editable again.
      const historyEntry = {
        action: 'moved_back', from_stage: 'tuesday-review', to_stage: 'concept-dev',
        moved_at: new Date().toISOString(), moved_by: req.user.name, moved_by_user_id: req.user.id,
      };
      await client.query(
        `UPDATE creative_assets SET concept_dev_status = 'in_development', review_history = review_history || $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify([historyEntry]), id]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, concept_id: id, from_stage: state.currentStage, to_stage: state.targetStage });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
