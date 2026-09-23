const express = require('express');
const { pool } = require('../db');
const { STATUSES } = require('../lib/statuses');

const router = express.Router();

// Final Approval's queue: every Concept Editing has submitted
// (editing_submitted_at set) that's still awaiting a decision
// (final_approval_status = 'pending', the column's default and what
// ready-for-approval resets it to on every submit/resubmit). Approve leaves
// editing_submitted_at set -- Editing's own UI still needs it to know the
// Concept is locked/read-only -- so final_approval_status is what actually
// drops an approved Concept out of this queue, not editing_submitted_at.
// Request Changes clears editing_submitted_at (dropping it out of this
// queue that way instead) so the Concept reappears in Editing's own
// "In Progress"/"Edited" counts too, keeping its final_approval_status =
// 'changes_required' and feedback on record until it's resubmitted.
const QUEUE_SELECT = `
  SELECT
    ca.id AS creative_asset_id, ca.concept_name, ca.format, ca.editing_submitted_at,
    ca.final_approval_status, ca.final_approval_feedback, ca.final_approved_at,
    fe.id AS final_edit_id, fe.final_edit_link, fe.editor, fe.editor_notes, fe.asset_name AS final_edit_asset_name,
    spi.product_name, spi.image_url, ca.editing_owner, ss.id AS shoot_schedule_id
  FROM creative_assets ca
  LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
  LEFT JOIN shoot_schedule ss ON ss.creative_asset_id = ca.id
  LEFT JOIN LATERAL (
    SELECT * FROM final_edits fe2 WHERE fe2.creative_asset_id = ca.id ORDER BY fe2.created_at ASC LIMIT 1
  ) fe ON true
  WHERE ca.editing_submitted_at IS NOT NULL AND ca.final_approval_status = 'pending'
  ORDER BY ca.editing_submitted_at ASC
`;

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(QUEUE_SELECT);
    res.json({ concepts: result.rows });
  } catch (err) {
    next(err);
  }
});

// Approve -- stamps who/when and advances the Concept's canonical `status`
// into the existing 'qc' Kanban stage if it hasn't already reached it (Drop
// concepts often already have via editing.js's syncDropStatusForward; Core/
// High Stock/Promotion concepts reach it here for the first time). Recorded
// in status_history same as every other status advance in this app.
router.post('/concepts/:id/approve', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query(
      'SELECT id, status, editing_submitted_at FROM creative_assets WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existingResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Concept not found' });
    }
    const existing = existingResult.rows[0];
    if (!existing.editing_submitted_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This Concept is not awaiting Final Approval' });
    }
    const advanceStatus = STATUSES.indexOf(existing.status) < STATUSES.indexOf('qc');
    const nextStatus = advanceStatus ? 'qc' : existing.status;

    const result = await client.query(
      `UPDATE creative_assets SET
         final_approval_status = 'approved',
         final_approved_at = now(),
         final_approved_by_user_id = $1,
         final_approval_feedback = NULL,
         status = $2,
         updated_at = now()
       WHERE id = $3 RETURNING *`,
      [req.user.id, nextStatus, req.params.id]
    );
    if (advanceStatus) {
      await client.query(
        `INSERT INTO status_history (creative_asset_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)`,
        [req.params.id, existing.status, nextStatus, req.user.name]
      );
    }
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Request Changes -- sends the SAME Concept (and its existing Final Edit
// row) back into Editing's normal queue, never a duplicate: clearing
// editing_submitted_at is exactly what editingConceptStatus/the client's
// Editing queue already read as "not yet submitted", so it just reappears
// there with its final_edits row untouched, plus the feedback recorded here
// for the editor to see (see renderEditingConceptModal's changes-required
// banner).
router.post('/concepts/:id/request-changes', async (req, res, next) => {
  try {
    const { feedback } = req.body || {};
    const trimmedFeedback = feedback && feedback.trim() ? feedback.trim() : null;
    if (!trimmedFeedback) return res.status(400).json({ error: 'feedback is required to request changes' });

    const result = await pool.query(
      `UPDATE creative_assets SET
         final_approval_status = 'changes_required',
         final_approval_feedback = $1,
         editing_submitted_at = NULL,
         editing_submitted_by_user_id = NULL,
         updated_at = now()
       WHERE id = $2 AND editing_submitted_at IS NOT NULL
       RETURNING *`,
      [trimmedFeedback, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Concept not found or not awaiting Final Approval' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
