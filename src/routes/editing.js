const express = require('express');
const { pool } = require('../db');
const { FINAL_EDIT_FORMATS, STATUSES, SHOOT_DAYS } = require('../lib/statuses');

const router = express.Router();

// Drop -> Shooting -> Editing progress sync (see the Drop brief, item 9) --
// same reasoning/scoping as shooting.js's syncDropStatusForward: only ever
// advances the canonical creative_assets.status forward, only for
// Drop-sourced concepts, so Core/Promotion's status (never auto-advanced by
// Editing before this) is unaffected. No business-rule gate applies here --
// assertCanEnterFilming only guards entry into 'filming', not 'qc'.
async function syncDropStatusForward(client, creativeAssetId, atLeastStatus) {
  const result = await client.query(
    `SELECT ca.status FROM creative_assets ca
     LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
     WHERE ca.id = $1 AND spi.source = 'drop'`,
    [creativeAssetId]
  );
  if (!result.rows.length) return;
  const currentStatus = result.rows[0].status;
  if (STATUSES.indexOf(currentStatus) >= STATUSES.indexOf(atLeastStatus)) return;
  await client.query(`UPDATE creative_assets SET status = $1, updated_at = now() WHERE id = $2`, [atLeastStatus, creativeAssetId]);
  await client.query(
    `INSERT INTO status_history (creative_asset_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)`,
    [creativeAssetId, currentStatus, atLeastStatus, 'Editing']
  );
}

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
// editing_owner (see G's investigation): the Editing assignment made in
// Upcoming Drops/Promotion intake was, until now, write-only -- nothing on
// this page ever read it back, so "Editing = Shez" had no effect once a
// concept actually reached Editing. Selecting it here is what lets the new
// per-editor filter (see setEditingEditorFilter in app.js) work off the
// same assignment made at planning time, with nothing re-entered.
// editing_week_start/editing_day/editing_original_week_start (see the Shoot
// Week/Scheduling brief, item 8): Editing's OWN weekly calendar, separate
// from the shoot's own scheduled_week_start/scheduled_day -- a Concept is
// filtered into this week by WHEN IT'S BEING EDITED, not when it was
// filmed, so it can carry across weeks independently of Shooting.
const CONCEPT_SELECT = `
  SELECT
    ss.id AS shoot_schedule_id, ss.scheduled_week_start, ss.shot_at,
    ss.editing_original_week_start, ss.editing_week_start, ss.editing_day,
    ca.id AS creative_asset_id, ca.concept_name, ca.format AS concept_format,
    ca.hook_variations, ca.location, ca.editing_submitted_at, ca.editing_started_at, ca.editing_owner,
    ca.final_approval_status, ca.final_approval_feedback,
    spi.product_name, spi.image_url, spi.creator AS owner
  FROM shoot_schedule ss
  JOIN creative_assets ca ON ca.id = ss.creative_asset_id
  LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
  WHERE ss.ready_for_editing = true AND ss.editing_week_start = $1
  ORDER BY ca.concept_name ASC
`;

// Self-healing-on-read, same pattern as shooting.js's backfillApprovedConcepts
// and conceptDevelopment.js's generateOrTopUpPlan: any row that was already
// Shot before editing_week_start existed (or before mark-shot started setting
// it) gets placed into Editing's calendar now, as Unscheduled in whatever
// week its shoot was scheduled for -- nothing to migrate by hand.
async function backfillEditingCalendar() {
  await pool.query(
    `UPDATE shoot_schedule SET
       editing_original_week_start = COALESCE(scheduled_week_start, date_trunc('week', now())::date),
       editing_week_start = COALESCE(scheduled_week_start, date_trunc('week', now())::date)
     WHERE ready_for_editing = true AND editing_week_start IS NULL`
  );
}

// Editing is a handoff, not a checklist (see the Editing-simplification
// brief, item 9): ready-for-approval no longer requires every Hook
// Variation to have its own individually-matched, linked Final Edit --
// just that a Final Edit exists with a link pasted back, same low bar the
// client's own editingConceptStatus applies.
function conceptHasLinkedFinalEdit(finalEdits) {
  return finalEdits.some((fe) => fe.final_edit_link);
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
    await backfillEditingCalendar();
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
      editing_owner: c.editing_owner,
      shot_at: c.shot_at,
      editing_submitted_at: c.editing_submitted_at,
      editing_started_at: c.editing_started_at,
      final_approval_status: c.final_approval_status,
      final_approval_feedback: c.final_approval_feedback,
      editing_original_week_start: dateStr(c.editing_original_week_start),
      editing_week_start: dateStr(c.editing_week_start),
      editing_day: c.editing_day,
      carried_over: dateStr(c.editing_original_week_start) !== dateStr(c.editing_week_start),
      final_edits: editsByConcept.get(c.creative_asset_id) || [],
    }));

    res.json({ week_start: dateStr(resolvedWeekStart), concepts: shaped });
  } catch (err) {
    next(err);
  }
});

// Card-level "In Progress" -- a pure status transition, nothing else. Fixes
// the live-QA bug where clicking "In Progress" opened the Final Edit modal:
// that action used to piggyback on POST .../final-edits (below), which both
// creates a final_edits row and sets this same flag as a side effect. This
// route sets ONLY editing_started_at, so starting editing never creates a
// final_edits row, never opens any modal, and never touches
// editing_submitted_at/Final Approval. COALESCE keeps it idempotent -- a
// second click, or one after a Final Edit already exists (which also sets
// this column), never pushes the timestamp forward.
router.post('/concepts/:creativeAssetId/start', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE creative_assets SET editing_started_at = COALESCE(editing_started_at, now()), updated_at = now() WHERE id = $1 RETURNING id, editing_started_at`,
      [req.params.creativeAssetId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Concept not found' });
    res.json(result.rows[0]);
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
    // This action IS "started editing" -- see the Round 8 comment on the
    // column in schema.sql. COALESCE so a second batch of Final Edits on an
    // already-started Concept doesn't push the timestamp forward.
    await client.query(
      `UPDATE creative_assets SET editing_started_at = COALESCE(editing_started_at, now()), updated_at = now() WHERE id = $1`,
      [req.params.creativeAssetId]
    );
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

// Concept-level submission to Final Approval (see the Editing-simplification
// brief, item 9/11): just needs its one Final Edit's link pasted back --
// re-validated here rather than trusting the client's own state. Idempotent:
// re-calling once already submitted just returns the existing state rather
// than erroring.
router.post('/concepts/:creativeAssetId/ready-for-approval', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const conceptResult = await client.query('SELECT * FROM creative_assets WHERE id = $1', [req.params.creativeAssetId]);
    if (!conceptResult.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Concept not found' });
    }
    const concept = conceptResult.rows[0];
    if (concept.editing_submitted_at) {
      client.release();
      return res.json(concept);
    }

    const editsResult = await client.query('SELECT * FROM final_edits WHERE creative_asset_id = $1', [req.params.creativeAssetId]);
    if (!conceptHasLinkedFinalEdit(editsResult.rows)) {
      client.release();
      return res.status(400).json({ error: 'Add the Final Edit link before sending for approval' });
    }

    await client.query('BEGIN');
    // Resubmitting after Request Changes resets final_approval_status back
    // to 'pending' -- a fresh look, same Concept/final_edits row, not a new
    // Final Approval queue entry.
    const result = await client.query(
      `UPDATE creative_assets SET
         editing_submitted_at = now(), editing_submitted_by_user_id = $1,
         final_approval_status = 'pending', updated_at = now()
       WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.creativeAssetId]
    );
    await syncDropStatusForward(client, Number(req.params.creativeAssetId), 'qc');
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Corrects an accidentally-created Final Edit (e.g. the wrong hook
// suggestion checked) -- not a "discard this ad" action once real work has
// started, just cleanup for a mistake made seconds ago. Locked once the
// Concept has been submitted, same as the PATCH route above.
router.delete('/final-edits/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const existingResult = await client.query(
      `SELECT fe.id, fe.creative_asset_id, ca.editing_submitted_at FROM final_edits fe
       JOIN creative_assets ca ON ca.id = fe.creative_asset_id
       WHERE fe.id = $1`,
      [req.params.id]
    );
    if (!existingResult.rows.length) { client.release(); return res.status(404).json({ error: 'Final edit not found' }); }
    if (existingResult.rows[0].editing_submitted_at) {
      client.release();
      return res.status(400).json({ error: 'Concept already submitted for approval -- changes are locked' });
    }
    const creativeAssetId = existingResult.rows[0].creative_asset_id;

    await client.query('BEGIN');
    const result = await client.query('DELETE FROM final_edits WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Final edit not found' });
    }
    // If that was the Concept's last remaining Final Edit, undo the
    // "started editing" signal too -- otherwise removing an accidental
    // Final Edit would leave the card stuck showing In Progress with
    // nothing actually attached (see the Round 8 comment on the column).
    const remaining = await client.query('SELECT id FROM final_edits WHERE creative_asset_id = $1 LIMIT 1', [creativeAssetId]);
    if (!remaining.rows.length) {
      await client.query('UPDATE creative_assets SET editing_started_at = NULL, updated_at = now() WHERE id = $1', [creativeAssetId]);
    }
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Editing's own reschedule endpoint, mirroring shooting.js's PATCH /:id --
// the weekday "Move to..." menu, drag-and-drop, and Carry to next week all
// call this one route (see the Scheduling brief, item 12: "same as
// Shooting"). editing_day null means Unscheduled; editing_week_start
// omitted keeps the current editing week. Scoped to ready_for_editing = true
// rows only -- a Concept still in Shooting has nothing to reschedule here.
// Unlike Shooting's PATCH /:id, there's no status to preserve/reset: the
// workflow state (To Edit/Editing/Ready for Approval) is derived entirely
// from final_edits + editing_submitted_at, which this route never touches
// -- calendar placement and workflow progress are genuinely independent
// dimensions (see item 9), so moving a Concept's edit day can never
// accidentally undo or advance its progress.
router.patch('/schedule/:id', async (req, res, next) => {
  try {
    const { editing_day, editing_week_start } = req.body || {};
    if (editing_day !== null && editing_day !== undefined && !SHOOT_DAYS.includes(editing_day)) {
      return res.status(400).json({ error: `editing_day must be one of: ${SHOOT_DAYS.join(', ')}, or null` });
    }
    if (editing_week_start !== undefined && editing_week_start !== null && !WEEK_RE.test(editing_week_start)) {
      return res.status(400).json({ error: 'editing_week_start must be YYYY-MM-DD' });
    }
    const nextDay = editing_day === undefined ? null : editing_day;
    const result = await pool.query(
      `UPDATE shoot_schedule SET
         editing_day = $1::varchar,
         editing_week_start = COALESCE($2::date, editing_week_start),
         updated_at = now()
       WHERE id = $3 AND ready_for_editing = true
       RETURNING *`,
      [nextDay, editing_week_start || null, req.params.id]
    );
    if (!result.rows.length) {
      const existsResult = await pool.query('SELECT id, ready_for_editing FROM shoot_schedule WHERE id = $1', [req.params.id]);
      if (!existsResult.rows.length) return res.status(404).json({ error: 'Shoot schedule entry not found' });
      return res.status(409).json({ error: 'This Concept is not yet ready for Editing' });
    }
    const row = result.rows[0];
    res.json({
      ...row,
      original_week_start: dateStr(row.original_week_start),
      scheduled_week_start: dateStr(row.scheduled_week_start),
      editing_original_week_start: dateStr(row.editing_original_week_start),
      editing_week_start: dateStr(row.editing_week_start),
    });
  } catch (err) {
    next(err);
  }
});

// Editing's own History, one row per week that has ever had a Concept enter
// Editing -- same bucketing reasoning as shooting.js's GET /history.
// "Submitted" (Ready for Approval) is Editing's completion marker, the
// equivalent of Shooting's "shot".
router.get('/history', async (req, res, next) => {
  try {
    await backfillEditingCalendar();
    const result = await pool.query(
      `SELECT
         ss.editing_original_week_start AS week_start,
         COUNT(*)::int AS planned,
         COUNT(*) FILTER (WHERE ca.editing_submitted_at IS NOT NULL AND ss.editing_week_start = ss.editing_original_week_start)::int AS submitted,
         COUNT(*) FILTER (WHERE ss.editing_week_start != ss.editing_original_week_start)::int AS carried_over,
         COUNT(*) FILTER (WHERE ca.editing_submitted_at IS NULL AND ss.editing_week_start = ss.editing_original_week_start)::int AS not_completed
       FROM shoot_schedule ss
       JOIN creative_assets ca ON ca.id = ss.creative_asset_id
       WHERE ss.ready_for_editing = true
       GROUP BY ss.editing_original_week_start
       ORDER BY ss.editing_original_week_start DESC`
    );
    res.json({ weeks: result.rows.map((w) => ({ ...w, week_start: dateStr(w.week_start) })) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
