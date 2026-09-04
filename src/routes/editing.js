const express = require('express');
const { pool } = require('../db');
const { FINAL_EDIT_FORMATS } = require('../lib/statuses');

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
// assets without a second round trip. editing_submitted_at is the Concept's
// own Ready for Approval flag (see the workflow-revision brief) -- the
// client derives everything else (required/complete counts, editing_status)
// from this plus final_edits, so nothing else needs to ride along here.
const CONCEPT_SELECT = `
  SELECT
    ss.id AS shoot_schedule_id, ss.scheduled_week_start, ss.shot_at,
    ca.id AS creative_asset_id, ca.concept_name, ca.format AS concept_format,
    ca.hook_variations, ca.location, ca.editing_submitted_at,
    spi.product_name, spi.image_url, spi.creator AS owner
  FROM shoot_schedule ss
  JOIN creative_assets ca ON ca.id = ss.creative_asset_id
  LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
  WHERE ss.ready_for_editing = true AND ss.scheduled_week_start = $1
  ORDER BY ca.concept_name ASC
`;

// Same Hook-Variation-to-Final-Edit matching the client uses (see app.js's
// editingConceptRequirements) -- required to independently validate a
// Ready for Approval submission server-side rather than trusting the
// client's own completion count.
function conceptCompletion(hookVariations, finalEdits) {
  const hookTexts = (Array.isArray(hookVariations) ? hookVariations : [])
    .filter((h) => h && h.text && h.text.trim())
    .map((h) => h.text.trim());
  const used = new Set();
  let complete = 0;
  for (const text of hookTexts) {
    const match = finalEdits.find((fe) => !used.has(fe.id) && (fe.variation_text || '').trim() === text);
    if (match) {
      used.add(match.id);
      if (match.final_edit_link) complete += 1;
    }
  }
  const customEdits = finalEdits.filter((fe) => !used.has(fe.id));
  complete += customEdits.filter((fe) => fe.final_edit_link).length;
  return { required: hookTexts.length + customEdits.length, complete };
}

// Editing's landing page: every Shot Concept for the week, each with its
// Final Edits nested underneath -- the Concept is the workflow unit now
// (see the workflow-revision brief), so no summary counts are computed here.
// The client derives every completion fraction, status, and aggregate
// (landing card, filters, summary line) from hook_variations + final_edits +
// editing_submitted_at via one shared function (editingConceptRequirements
// in app.js), so there's a single source of truth instead of a server copy
// that could drift from it.
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

    const shaped = concepts.map((c) => ({
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
      editing_submitted_at: c.editing_submitted_at,
      final_edits: editsByConcept.get(c.creative_asset_id) || [],
    }));

    res.json({ week_start: dateStr(resolvedWeekStart), concepts: shaped });
  } catch (err) {
    next(err);
  }
});

// Bulk-create Final Edits for one Concept -- covers both the multi-select
// "Create Final Edits" gesture and a single Hook checklist row's "Add Final
// Edit" (a one-item array). Never auto-creates from hook_variations on its
// own; the editor must explicitly confirm what was actually filmed by what
// they submit here (see the brief, item 5). Locked once the Concept has
// already been submitted for approval -- adding a Final Edit afterward
// would silently change what "required" meant for a submission that's
// already gone to Final Approval.
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

    const conceptResult = await client.query('SELECT id, editing_submitted_at FROM creative_assets WHERE id = $1', [req.params.creativeAssetId]);
    if (!conceptResult.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Concept not found' });
    }
    if (conceptResult.rows[0].editing_submitted_at) {
      client.release();
      return res.status(400).json({ error: 'Concept already submitted for approval' });
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
// status is never client-set at all anymore: Ready for Approval is now a
// Concept-level action (see POST .../ready-for-approval below), so this
// route only ever derives 'to_edit' -> 'editing' the moment real work
// exists on a still-untouched record -- an editor assigned or a link saved.
// final_edit_link changing appends a lightweight history entry (see
// schema.sql's comment on final_edit_history) rather than overwriting
// silently. Locked entirely once the parent Concept has been submitted for
// approval -- see the workflow-revision brief, item 6/11.
router.patch('/final-edits/:id', async (req, res, next) => {
  try {
    const { asset_name, format, variation_text, editor, status, final_edit_link, editor_notes } = req.body || {};
    if (format !== undefined && format !== null && !FINAL_EDIT_FORMATS.includes(format)) {
      return res.status(400).json({ error: `format must be one of: ${FINAL_EDIT_FORMATS.join(', ')}` });
    }
    if (status !== undefined && status !== null) {
      return res.status(400).json({ error: 'status is derived automatically and cannot be set directly' });
    }

    const existingResult = await pool.query(
      `SELECT fe.*, ca.editing_submitted_at FROM final_edits fe
       JOIN creative_assets ca ON ca.id = fe.creative_asset_id
       WHERE fe.id = $1`,
      [req.params.id]
    );
    if (!existingResult.rows.length) return res.status(404).json({ error: 'Final edit not found' });
    const existing = existingResult.rows[0];
    if (existing.editing_submitted_at) {
      return res.status(400).json({ error: 'Concept already submitted for approval -- changes are locked' });
    }

    const linkProvided = final_edit_link !== undefined;
    const trimmedLink = linkProvided ? (final_edit_link && final_edit_link.trim() ? final_edit_link.trim() : null) : null;
    const linkChanging = linkProvided && trimmedLink !== existing.final_edit_link;
    const effectiveLink = linkProvided ? trimmedLink : existing.final_edit_link;

    const editorProvided = editor !== undefined;
    const effectiveEditor = editorProvided ? editor : existing.editor;
    const newStatus = existing.status === 'to_edit' && ((effectiveEditor && effectiveEditor.trim()) || effectiveLink)
      ? 'editing'
      : null;

    const historyEntries = linkChanging && trimmedLink
      ? JSON.stringify([{ url: trimmedLink, updated_at: new Date().toISOString(), updated_by: req.user.name }])
      : JSON.stringify([]);

    const variationProvided = variation_text !== undefined;
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
         updated_at = now()
       WHERE id = $14 RETURNING *`,
      [
        asset_name && asset_name.trim() ? asset_name.trim() : null,
        format || null,
        variationProvided, variationProvided ? variation_text : null,
        editorProvided, editorProvided ? editor : null,
        newStatus,
        linkProvided, effectiveLink,
        linkChanging,
        historyEntries,
        notesProvided, notesProvided ? editor_notes : null,
        req.params.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Concept-level submission to Final Approval -- the important workflow
// change (see the brief, item 6/11): the Concept and its complete set of
// Final Edits move together as one unit, not one Final Edit at a time.
// Requires every Hook Variation to have a matching, linked Final Edit (plus
// any custom/manual ones added) -- re-validated here rather than trusting
// the client's own completion count. Idempotent: re-calling once already
// submitted just returns the existing state rather than erroring.
router.post('/concepts/:creativeAssetId/ready-for-approval', async (req, res, next) => {
  try {
    const conceptResult = await pool.query('SELECT * FROM creative_assets WHERE id = $1', [req.params.creativeAssetId]);
    if (!conceptResult.rows.length) return res.status(404).json({ error: 'Concept not found' });
    const concept = conceptResult.rows[0];
    if (concept.editing_submitted_at) return res.json(concept);

    const editsResult = await pool.query('SELECT * FROM final_edits WHERE creative_asset_id = $1', [req.params.creativeAssetId]);
    const { required, complete } = conceptCompletion(concept.hook_variations, editsResult.rows);
    if (required === 0 || complete < required) {
      return res.status(400).json({ error: 'Complete all Final Edits before sending for approval' });
    }

    const result = await pool.query(
      `UPDATE creative_assets SET editing_submitted_at = now(), editing_submitted_by_user_id = $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.creativeAssetId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Corrects an accidentally-created Final Edit (e.g. the wrong hook
// suggestion checked) -- not a "discard this ad" action once real work has
// started, just cleanup for a mistake made seconds ago. Locked once the
// Concept has been submitted, same as the PATCH route above.
router.delete('/final-edits/:id', async (req, res, next) => {
  try {
    const existingResult = await pool.query(
      `SELECT fe.id, ca.editing_submitted_at FROM final_edits fe
       JOIN creative_assets ca ON ca.id = fe.creative_asset_id
       WHERE fe.id = $1`,
      [req.params.id]
    );
    if (!existingResult.rows.length) return res.status(404).json({ error: 'Final edit not found' });
    if (existingResult.rows[0].editing_submitted_at) {
      return res.status(400).json({ error: 'Concept already submitted for approval -- changes are locked' });
    }
    const result = await pool.query('DELETE FROM final_edits WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Final edit not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
