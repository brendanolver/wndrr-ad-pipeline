const express = require('express');
const { pool } = require('../db');
const { EDITING_STATUSES, FINAL_EDIT_FORMATS } = require('../lib/statuses');

const router = express.Router();

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_START_SQL = `COALESCE($1::date, date_trunc('week', now())::date)`;

// Same local-date-safety reasoning as shooting.js's own dateStr -- node-pg
// parses DATE columns from local Y/M/D fields, so reading those same fields
// back out (rather than toISOString(), which is UTC) never shifts the date.
function dateStr(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// One row per Concept that's Shot and ready for Editing -- Product/Owner
// context comes straight from the same shoot_plan_items join Shooting
// already uses, so nothing here is re-entered. hook_variations rides along
// so the "Create Final Edits" flow can suggest Primary/Alternative Hook
// assets without a second round trip.
const CONCEPT_SELECT = `
  SELECT
    ss.id AS shoot_schedule_id, ss.scheduled_week_start, ss.shot_at,
    ca.id AS creative_asset_id, ca.concept_name, ca.format AS concept_format,
    ca.hook_variations, ca.location,
    spi.product_name, spi.image_url, spi.creator AS owner
  FROM shoot_schedule ss
  JOIN creative_assets ca ON ca.id = ss.creative_asset_id
  LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
  WHERE ss.ready_for_editing = true AND ss.scheduled_week_start = $1
  ORDER BY ca.concept_name ASC
`;

// Editing's landing page: every Shot Concept for the week, each with its
// Final Edits nested underneath (see the brief: "Group by Concept" --
// Product -> Concept -> Final Edit, never one flat list). The summary
// counts are computed here rather than client-side so the header line
// always matches exactly what the week actually contains, filter or no
// filter.
router.get('/', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }
    const resolvedWeekResult = await pool.query(`SELECT ${WEEK_START_SQL} AS week_start`, [weekStart || null]);
    const resolvedWeekStart = resolvedWeekResult.rows[0].week_start;

    const conceptsResult = await pool.query(CONCEPT_SELECT, [resolvedWeekStart]);
    const concepts = conceptsResult.rows;

    // id as a tiebreaker: a bulk-create can insert several rows within the
    // same millisecond, and created_at alone doesn't guarantee a stable
    // order across repeated queries when timestamps tie -- see the brief's
    // own "Create Final Edits" list order.
    const editsResult = concepts.length
      ? await pool.query(
          `SELECT * FROM final_edits WHERE creative_asset_id = ANY($1::int[]) ORDER BY created_at ASC, id ASC`,
          [concepts.map((c) => c.creative_asset_id)]
        )
      : { rows: [] };
    const editsByConcept = new Map();
    for (const row of editsResult.rows) {
      if (!editsByConcept.has(row.creative_asset_id)) editsByConcept.set(row.creative_asset_id, []);
      editsByConcept.get(row.creative_asset_id).push(row);
    }

    let toEdit = 0;
    let editing = 0;
    let readyForApproval = 0;
    let totalEdits = 0;
    const shaped = concepts.map((c) => {
      const finalEdits = editsByConcept.get(c.creative_asset_id) || [];
      for (const fe of finalEdits) {
        totalEdits += 1;
        if (fe.status === 'to_edit') toEdit += 1;
        else if (fe.status === 'editing') editing += 1;
        else if (fe.status === 'ready_for_approval') readyForApproval += 1;
      }
      return {
        shoot_schedule_id: c.shoot_schedule_id,
        creative_asset_id: c.creative_asset_id,
        concept_name: c.concept_name,
        concept_format: c.concept_format,
        hook_variations: c.hook_variations,
        location: c.location,
        product_name: c.product_name,
        image_url: c.image_url,
        owner: c.owner,
        shot_at: c.shot_at,
        final_edits: finalEdits,
      };
    });

    res.json({
      week_start: dateStr(resolvedWeekStart),
      summary: { concepts: shaped.length, final_edits: totalEdits, to_edit: toEdit, editing, ready_for_approval: readyForApproval },
      concepts: shaped,
    });
  } catch (err) {
    next(err);
  }
});

// Bulk-create Final Edits for one Concept -- the "Create Final Edits" flow
// (checked Hook suggestions + any "+ Add Another Asset" rows, all created
// together in one transaction). Never auto-creates from hook_variations on
// its own; the editor must explicitly confirm what was actually filmed by
// what they submit here (see the brief, item 5).
router.post('/concepts/:creativeAssetId/final-edits', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { assets } = req.body || {};
    if (!Array.isArray(assets) || !assets.length) {
      client.release();
      return res.status(400).json({ error: 'assets must be a non-empty array' });
    }
    for (const a of assets) {
      if (!a || !a.asset_name || !a.asset_name.trim()) {
        client.release();
        return res.status(400).json({ error: 'Each asset needs an asset_name' });
      }
      if (a.format !== undefined && a.format !== null && !FINAL_EDIT_FORMATS.includes(a.format)) {
        client.release();
        return res.status(400).json({ error: `format must be one of: ${FINAL_EDIT_FORMATS.join(', ')}` });
      }
    }

    const conceptResult = await client.query('SELECT id FROM creative_assets WHERE id = $1', [req.params.creativeAssetId]);
    if (!conceptResult.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Concept not found' });
    }

    await client.query('BEGIN');
    const created = [];
    for (const a of assets) {
      const result = await client.query(
        `INSERT INTO final_edits (creative_asset_id, asset_name, format, variation_text, editor, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.params.creativeAssetId, a.asset_name.trim(), a.format || 'video', a.variation_text || null, a.editor || null, req.user.id]
      );
      created.push(result.rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json(created);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// The one place a Final Edit's own workspace gets edited -- asset_name,
// format, variation_text, editor, editor_notes are plain field updates.
// status/final_edit_link are the two workflow-meaningful ones: changing the
// link appends a lightweight history entry (see schema.sql's comment on
// final_edit_history) rather than overwriting silently, and moving into
// ready_for_approval requires a link to already be set (this save's own
// link included) and stamps ready_for_approval_at once, on the transition
// only -- same pattern as Concept Dev's submitted_for_review_at.
router.patch('/final-edits/:id', async (req, res, next) => {
  try {
    const { asset_name, format, variation_text, editor, status, final_edit_link, editor_notes } = req.body || {};
    if (format !== undefined && format !== null && !FINAL_EDIT_FORMATS.includes(format)) {
      return res.status(400).json({ error: `format must be one of: ${FINAL_EDIT_FORMATS.join(', ')}` });
    }
    if (status !== undefined && status !== null && !EDITING_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${EDITING_STATUSES.join(', ')}` });
    }

    const existingResult = await pool.query('SELECT * FROM final_edits WHERE id = $1', [req.params.id]);
    if (!existingResult.rows.length) return res.status(404).json({ error: 'Final edit not found' });
    const existing = existingResult.rows[0];

    const linkProvided = final_edit_link !== undefined;
    const trimmedLink = linkProvided ? (final_edit_link && final_edit_link.trim() ? final_edit_link.trim() : null) : null;
    const linkChanging = linkProvided && trimmedLink !== existing.final_edit_link;
    const effectiveLink = linkProvided ? trimmedLink : existing.final_edit_link;

    if (status === 'ready_for_approval' && !effectiveLink) {
      return res.status(400).json({ error: 'Add a Final Edit link before sending for approval' });
    }
    const movingToReady = status === 'ready_for_approval' && existing.status !== 'ready_for_approval';

    const historyEntries = linkChanging && trimmedLink
      ? JSON.stringify([{ url: trimmedLink, updated_at: new Date().toISOString(), updated_by: req.user.name }])
      : JSON.stringify([]);

    const variationProvided = variation_text !== undefined;
    const editorProvided = editor !== undefined;
    const notesProvided = editor_notes !== undefined;

    const result = await pool.query(
      `UPDATE final_edits SET
         asset_name = COALESCE($1, asset_name),
         format = COALESCE($2, format),
         variation_text = CASE WHEN $3 THEN $4 ELSE variation_text END,
         editor = CASE WHEN $5 THEN $6 ELSE editor END,
         status = COALESCE($7, status),
         final_edit_link = CASE WHEN $8 THEN $9 ELSE final_edit_link END,
         final_edit_updated_at = CASE WHEN $10 THEN now() ELSE final_edit_updated_at END,
         final_edit_history = final_edit_history || $11::jsonb,
         editor_notes = CASE WHEN $12 THEN $13 ELSE editor_notes END,
         ready_for_approval_at = CASE WHEN $14 THEN now() ELSE ready_for_approval_at END,
         updated_at = now()
       WHERE id = $15 RETURNING *`,
      [
        asset_name && asset_name.trim() ? asset_name.trim() : null,
        format || null,
        variationProvided, variationProvided ? variation_text : null,
        editorProvided, editorProvided ? editor : null,
        status || null,
        linkProvided, effectiveLink,
        linkChanging,
        historyEntries,
        notesProvided, notesProvided ? editor_notes : null,
        movingToReady,
        req.params.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Corrects an accidentally-created Final Edit (e.g. the wrong hook
// suggestion checked) -- not a "discard this ad" action once real work has
// started, just cleanup for a mistake made seconds ago.
router.delete('/final-edits/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM final_edits WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Final edit not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
