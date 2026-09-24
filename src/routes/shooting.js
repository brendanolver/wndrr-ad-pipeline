const express = require('express');
const { pool } = require('../db');
const { SHOOT_DAYS, STATUSES } = require('../lib/statuses');
const { assertCanEnterFilming, RuleViolationError } = require('../lib/rules');

const router = express.Router();

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_START_SQL = `COALESCE($1::date, date_trunc('week', now())::date)`;

// node-pg parses a DATE column into a Date built from its LOCAL Y/M/D
// fields (see pg-types' parseDate) -- res.json()'s default Date
// serialization instead calls toISOString(), which converts to UTC and can
// silently shift the date by a day depending on the server's timezone. This
// reads the same local fields pg used to build the Date, so every date this
// route sends the frontend is an unambiguous, timezone-safe YYYY-MM-DD.
function dateStr(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Compact card-level fields only -- Week/Today views stay scannable, full
// detail (script, references, audience, etc.) only loads when a Shoot
// Brief is actually opened (GET /:id/brief below). hook_variations is the
// one exception: small enough to include here, and Today's worklist needs
// a Primary Hook preview without a second round trip per card.
// drop_name: resolved only for source = 'drop' cards, via the one colourway
// ensureDropProductionLinkage links onto the shoot_plan_item (see
// dropProductPlans.js) -- lets Mark/Shez see which Drop a card belongs to
// without a second Drop-only Shooting view (see the Drop -> Shooting brief,
// item 8: "carry clear Drop context... do not invent a second page").
const SUMMARY_SELECT = `
  SELECT
    ss.id, ss.creative_asset_id, ss.status, ss.original_week_start,
    ss.scheduled_week_start, ss.scheduled_day, ss.shot_at, ss.ready_for_editing,
    ca.concept_name, ca.location, ca.hook_variations, ca.format,
    spi.product_name, spi.image_url, spi.creator AS owner, spi.source,
    (SELECT d.name FROM shoot_plan_item_styles spis
       JOIN styles sty ON sty.id = spis.style_id JOIN drops d ON d.id = sty.drop_id
       WHERE spis.shoot_plan_item_id = spi.id LIMIT 1) AS drop_name
  FROM shoot_schedule ss
  JOIN creative_assets ca ON ca.id = ss.creative_asset_id
  LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
`;

// Approved concepts normally get their shoot_schedule row the instant Tuesday
// Review approves them (see conceptDevelopment.js's PATCH /concepts/:id/review).
// That only fires at the moment of the transition though, so anything
// approved before that handoff existed -- or through any future path that
// bypasses it -- would otherwise sit in Concept Dev forever with no way into
// Shooting. Same self-healing-on-read pattern as Concept Development's
// generateOrTopUpPlan: every read here first guarantees every approved
// concept has a schedule row, so there's nothing to backfill or migrate by
// hand -- the next load just fixes it.
async function backfillApprovedConcepts() {
  await pool.query(
    `INSERT INTO shoot_schedule (creative_asset_id, status, original_week_start, scheduled_week_start)
     SELECT ca.id, 'unscheduled',
            COALESCE(spi.week_start, date_trunc('week', now())::date),
            COALESCE(spi.week_start, date_trunc('week', now())::date)
     FROM creative_assets ca
     LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
     WHERE ca.concept_dev_status = 'approved'
     ON CONFLICT (creative_asset_id) DO NOTHING`
  );
}

// Week View's entire payload in one call: the Unscheduled bucket plus each
// weekday's cards, already bucketed server-side so the frontend just
// renders what it's given. "Planned" in the header summary only counts
// cards actually assigned to a weekday (Monday-Friday) -- Unscheduled is
// its own separate count, since nothing there has been committed to a day
// yet.
router.get('/', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }
    await backfillApprovedConcepts();
    const resolvedWeekResult = await pool.query(`SELECT ${WEEK_START_SQL} AS week_start`, [weekStart || null]);
    const resolvedWeekStart = resolvedWeekResult.rows[0].week_start;

    const rowsResult = await pool.query(
      `${SUMMARY_SELECT} WHERE ss.scheduled_week_start = $1 ORDER BY ca.concept_name ASC`,
      [resolvedWeekStart]
    );

    const unscheduled = [];
    const days = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [] };
    let planned = 0;
    let shot = 0;
    for (const row of rowsResult.rows) {
      const item = {
        ...row,
        original_week_start: dateStr(row.original_week_start),
        scheduled_week_start: dateStr(row.scheduled_week_start),
        carried_over: row.original_week_start.getTime() !== row.scheduled_week_start.getTime(),
      };
      if (!row.scheduled_day) {
        unscheduled.push(item);
        continue;
      }
      days[row.scheduled_day].push(item);
      planned += 1;
      if (row.status === 'shot') shot += 1;
    }

    res.json({
      week_start: dateStr(resolvedWeekStart),
      summary: { planned, shot, remaining: planned - shot },
      unscheduled,
      days,
    });
  } catch (err) {
    next(err);
  }
});

// The read-only Shoot Brief -- everything the approved Concept already has,
// nothing re-entered. Same "what exactly am I meant to capture" fields the
// brief called out: idea/audience kept present but de-emphasized, execution/
// hook/script/references/shoot-requirements are the point.
router.get('/:id/brief', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         ss.id, ss.status, ss.original_week_start, ss.scheduled_week_start,
         ss.scheduled_day, ss.shot_at, ss.ready_for_editing,
         ca.id AS creative_asset_id,
         ca.concept_name, ca.angle, ca.execution, ca.script_notes, ca.hook_variations, ca.shots,
         ca.reference_items, ca.talent_requirement, ca.location, ca.props_notes,
         ca.customer_avatar_id, ca.custom_avatar_description, ca.avatar_why_care,
         ca.concept_dev_status, ca.reviewed_at,
         spi.product_name, spi.image_url, spi.creator AS owner, spi.source, spi.id AS shoot_plan_item_id
       FROM shoot_schedule ss
       JOIN creative_assets ca ON ca.id = ss.creative_asset_id
       LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
       WHERE ss.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shoot schedule entry not found' });
    const brief = result.rows[0];

    let colourways = [];
    let dropName = null;
    if (brief.shoot_plan_item_id) {
      const stylesResult = await pool.query(
        `SELECT s.style_code, spis.colour_label, spis.size, d.name AS drop_name
         FROM shoot_plan_item_styles spis
         JOIN styles s ON s.id = spis.style_id
         LEFT JOIN drops d ON d.id = s.drop_id
         WHERE spis.shoot_plan_item_id = $1`,
        [brief.shoot_plan_item_id]
      );
      colourways = stylesResult.rows.map(({ drop_name, ...rest }) => rest);
      dropName = stylesResult.rows.find((r) => r.drop_name)?.drop_name || null;
    }

    let avatarName = null;
    if (brief.customer_avatar_id) {
      const avatarResult = await pool.query('SELECT name FROM customer_avatars WHERE id = $1', [brief.customer_avatar_id]);
      avatarName = avatarResult.rows[0] ? avatarResult.rows[0].name : null;
    }

    delete brief.shoot_plan_item_id;
    res.json({
      ...brief,
      original_week_start: dateStr(brief.original_week_start),
      scheduled_week_start: dateStr(brief.scheduled_week_start),
      colourways,
      drop_name: dropName,
      avatar_name: avatarName,
    });
  } catch (err) {
    next(err);
  }
});

// One reschedule endpoint for every way a card moves -- the weekday "Move
// to..." dropdown, drag-and-drop, and Carry Over (which just also changes
// scheduled_week_start) all call this. scheduled_day: null means Unscheduled.
// scheduled_week_start omitted keeps the current week (a same-week move).
// A concept already marked Shot is locked in place -- see item 8, "keep the
// Concept visible on the same weekday" -- there's no un-shooting in V1.
router.patch('/:id', async (req, res, next) => {
  try {
    const { scheduled_day, scheduled_week_start } = req.body || {};
    if (scheduled_day !== null && scheduled_day !== undefined && !SHOOT_DAYS.includes(scheduled_day)) {
      return res.status(400).json({ error: `scheduled_day must be one of: ${SHOOT_DAYS.join(', ')}, or null` });
    }
    if (scheduled_week_start !== undefined && scheduled_week_start !== null && !WEEK_RE.test(scheduled_week_start)) {
      return res.status(400).json({ error: 'scheduled_week_start must be YYYY-MM-DD' });
    }
    const nextDay = scheduled_day === undefined ? null : scheduled_day;

    // Assignment and schedule are separate (see the Scheduling brief, item
    // 4): moving a card to another day/week must never change WHO owns it
    // (that's a plain UPDATE of scheduled_day/scheduled_week_start only,
    // never touching creative_asset_id/shoot_plan_items.creator) and must
    // never quietly reset production progress either. Rescheduling onto a
    // day preserves whatever status the card already had ('scheduled' or
    // 'in_progress' both stay as they are -- only a card that was still
    // 'unscheduled' advances to 'scheduled' the first time it gets a day);
    // rescheduling OFF a day (back to Unscheduled) always resets to
    // 'unscheduled', since "in progress on no particular day" isn't a real
    // state. 'shot' is excluded entirely by the WHERE guard below, same as
    // before -- completed work never becomes outstanding again just because
    // scheduling data changes.
    const result = await pool.query(
      `UPDATE shoot_schedule SET
         scheduled_day = $1::varchar,
         scheduled_week_start = COALESCE($2::date, scheduled_week_start),
         status = CASE
           WHEN $1::varchar IS NULL THEN 'unscheduled'
           WHEN status = 'unscheduled' THEN 'scheduled'
           ELSE status
         END,
         updated_at = now()
       WHERE id = $3 AND status != 'shot'
       RETURNING *`,
      [nextDay, scheduled_week_start || null, req.params.id]
    );
    if (!result.rows.length) {
      const existsResult = await pool.query('SELECT id, status FROM shoot_schedule WHERE id = $1', [req.params.id]);
      if (!existsResult.rows.length) return res.status(404).json({ error: 'Shoot schedule entry not found' });
      return res.status(409).json({ error: 'This Concept has already been marked Shot and can no longer be moved' });
    }
    const row = result.rows[0];
    res.json({ ...row, original_week_start: dateStr(row.original_week_start), scheduled_week_start: dateStr(row.scheduled_week_start) });
  } catch (err) {
    next(err);
  }
});

// Drop -> Shooting -> Editing progress sync (see the brief, item 9): the
// SAME canonical creative_assets.status Upcoming Drops' Filmed/Edited/
// Uploaded checkboxes already read and write (see app.js's
// CONCEPT_PROGRESS_STAGES) -- no parallel state. Scoped to Drop-sourced
// concepts only (asset.shoot_plan_item.source = 'drop') so Core/Promotion's
// canonical status, which nothing in Shooting/Editing has ever auto-advanced
// before this, is completely unaffected -- this only closes the gap for the
// one source that has no other way to reach 'filming'/'qc'. Only ever moves
// status FORWARD; a human can still always correct it via Upcoming Drops'
// own checkboxes. Reuses assertCanEnterFilming (the same New-Drop-style
// gate the generic PATCH /creative-assets/:id/status enforces) so this
// sync path can never silently bypass that business rule for a
// non-deliberate-trial New/Test Drop concept -- if the rule would block it,
// the shoot_schedule/mark-shot action itself still succeeds (the physical
// shoot already happened), it just leaves the canonical status, and
// therefore the Filmed checkbox, unmoved until that's resolved.
async function syncDropStatusForward(client, creativeAssetId, atLeastStatus) {
  const result = await client.query(
    `SELECT ca.status, ca.concept_classification, ca.is_deliberate_trial, s.tier AS style_tier
     FROM creative_assets ca
     LEFT JOIN styles s ON s.id = ca.style_id
     LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
     WHERE ca.id = $1 AND spi.source = 'drop'`,
    [creativeAssetId]
  );
  if (!result.rows.length) return;
  const asset = result.rows[0];
  if (STATUSES.indexOf(asset.status) >= STATUSES.indexOf(atLeastStatus)) return;
  try {
    if (atLeastStatus === 'filming') {
      assertCanEnterFilming({
        styleTier: asset.style_tier,
        conceptClassification: asset.concept_classification,
        isDeliberateTrial: asset.is_deliberate_trial,
      });
    }
  } catch (err) {
    if (err instanceof RuleViolationError) return;
    throw err;
  }
  await client.query(`UPDATE creative_assets SET status = $1, updated_at = now() WHERE id = $2`, [atLeastStatus, creativeAssetId]);
  await client.query(
    `INSERT INTO status_history (creative_asset_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)`,
    [creativeAssetId, asset.status, atLeastStatus, 'Shooting']
  );
}

// Mirror of syncDropStatusForward for unmark-shot -- only reverts when
// status is still EXACTLY the stage mark-shot itself advanced it to, so
// undoing an accidental click can never clobber progress made since (e.g.
// Editing has already moved it on to 'qc').
async function syncDropStatusRevert(client, creativeAssetId, fromStatus, toStatus) {
  const result = await client.query(
    `SELECT ca.status FROM creative_assets ca
     LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
     WHERE ca.id = $1 AND spi.source = 'drop'`,
    [creativeAssetId]
  );
  if (!result.rows.length || result.rows[0].status !== fromStatus) return;
  await client.query(`UPDATE creative_assets SET status = $1, updated_at = now() WHERE id = $2`, [toStatus, creativeAssetId]);
  await client.query(
    `INSERT INTO status_history (creative_asset_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)`,
    [creativeAssetId, fromStatus, toStatus, 'Shooting']
  );
}

// Production status step 1 of 2: Scheduled -> In Progress (see the
// Scheduling brief, item 7 -- an obvious, explicit control rather than a
// hidden badge-click). Deliberately does NOT set ready_for_editing -- only
// reaching 'shot' does, so a concept that's merely started can never leak
// into Editing.
router.post('/:id/start', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE shoot_schedule SET status = 'in_progress', updated_at = now()
       WHERE id = $1 AND status = 'scheduled'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) {
      const existsResult = await pool.query('SELECT id, status FROM shoot_schedule WHERE id = $1', [req.params.id]);
      if (!existsResult.rows.length) return res.status(404).json({ error: 'Shoot schedule entry not found' });
      return res.status(409).json({ error: `Only a Scheduled Concept can be started (this one is ${existsResult.rows[0].status})` });
    }
    const row = result.rows[0];
    res.json({ ...row, original_week_start: dateStr(row.original_week_start), scheduled_week_start: dateStr(row.scheduled_week_start) });
  } catch (err) {
    next(err);
  }
});

// Undoes /start -- back to Scheduled, same "accidentally clicked it"
// reasoning as unmark-shot below.
router.post('/:id/unstart', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE shoot_schedule SET status = 'scheduled', updated_at = now()
       WHERE id = $1 AND status = 'in_progress'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) {
      const existsResult = await pool.query('SELECT id, status FROM shoot_schedule WHERE id = $1', [req.params.id]);
      if (!existsResult.rows.length) return res.status(404).json({ error: 'Shoot schedule entry not found' });
      return res.status(409).json({ error: `Only an In Progress Concept can be reverted to Scheduled (this one is ${existsResult.rows[0].status})` });
    }
    const row = result.rows[0];
    res.json({ ...row, original_week_start: dateStr(row.original_week_start), scheduled_week_start: dateStr(row.scheduled_week_start) });
  } catch (err) {
    next(err);
  }
});

// Production status step 2 of 2 (or a direct jump from Scheduled, for a
// quick shoot that never needed the In Progress step) -- Scheduled OR In
// Progress -> Shot. Sets Ready for Editing so the next stage can pick it up
// later; nothing about Editing is built here.
router.post('/:id/mark-shot', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE shoot_schedule SET
         status = 'shot',
         shot_at = now(),
         ready_for_editing = true,
         editing_original_week_start = date_trunc('week', now())::date,
         editing_week_start = date_trunc('week', now())::date,
         editing_day = NULL,
         updated_at = now()
       WHERE id = $1 AND status IN ('scheduled', 'in_progress')
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) {
      const existsResult = await client.query('SELECT id, status FROM shoot_schedule WHERE id = $1', [req.params.id]);
      await client.query('ROLLBACK');
      if (!existsResult.rows.length) return res.status(404).json({ error: 'Shoot schedule entry not found' });
      return res.status(409).json({ error: `Only a Scheduled or In Progress Concept can be marked Shot (this one is ${existsResult.rows[0].status})` });
    }
    const row = result.rows[0];
    await syncDropStatusForward(client, row.creative_asset_id, 'filming');
    await client.query('COMMIT');
    res.json({ ...row, original_week_start: dateStr(row.original_week_start), scheduled_week_start: dateStr(row.scheduled_week_start) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Undoes mark-shot -- for the "accidentally clicked it" case, not a second
// production status. Clears shot_at/ready_for_editing back to their
// pre-Shot state and returns the Concept to Scheduled (draggable/movable
// again), rather than leaving it stuck as a permanent Shot record.
// Round 11: refuses once Editing has already submitted this Concept for
// Final Approval -- pulling ready_for_editing back to false at that point
// would silently strand an already-submitted Concept (still sitting in the
// Final Approval queue, which reads creative_assets directly and doesn't
// depend on ready_for_editing) while Shooting quietly disagreed about
// whether it was ever shot. Request Changes is the one supported way back
// from Final Approval (see finalApproval.js) -- this is deliberately not a
// second undo-approval path.
router.post('/:id/unmark-shot', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockResult = await client.query(
      `SELECT ca.editing_submitted_at FROM shoot_schedule ss
       JOIN creative_assets ca ON ca.id = ss.creative_asset_id
       WHERE ss.id = $1 AND ss.status = 'shot' FOR UPDATE OF ss`,
      [req.params.id]
    );
    if (lockResult.rows.length && lockResult.rows[0].editing_submitted_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This Concept has already been submitted to Final Approval and can no longer be reverted from Shooting -- use Request Changes in Final Approval instead.' });
    }
    const result = await client.query(
      `UPDATE shoot_schedule SET
         status = 'scheduled',
         shot_at = NULL,
         ready_for_editing = false,
         editing_original_week_start = NULL,
         editing_week_start = NULL,
         editing_day = NULL,
         updated_at = now()
       WHERE id = $1 AND status = 'shot'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) {
      const existsResult = await client.query('SELECT id, status FROM shoot_schedule WHERE id = $1', [req.params.id]);
      await client.query('ROLLBACK');
      if (!existsResult.rows.length) return res.status(404).json({ error: 'Shoot schedule entry not found' });
      return res.status(409).json({ error: `Only a Shot Concept can be unmarked (this one is ${existsResult.rows[0].status})` });
    }
    const row = result.rows[0];
    await syncDropStatusRevert(client, row.creative_asset_id, 'filming', 'concept_script');
    await client.query('COMMIT');
    res.json({ ...row, original_week_start: dateStr(row.original_week_start), scheduled_week_start: dateStr(row.scheduled_week_start) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Manager History, one row per week that has ever had a Concept enter
// Shooting. Bucketed purely from current state -- no separate "carried"
// flag to keep in sync: a Concept counts as Carried Over the moment its
// current scheduled_week_start no longer matches the week it was originally
// planned for, however many times it's moved since. Shot only counts
// towards its ORIGINAL week if it was actually shot there, without ever
// being carried elsewhere -- once carried, that week's plan is honestly
// incomplete even if the Concept is later shot somewhere else.
router.get('/history', async (req, res, next) => {
  try {
    await backfillApprovedConcepts();
    const result = await pool.query(
      `SELECT
         original_week_start AS week_start,
         COUNT(*)::int AS planned,
         COUNT(*) FILTER (WHERE status = 'shot' AND scheduled_week_start = original_week_start)::int AS shot,
         COUNT(*) FILTER (WHERE scheduled_week_start != original_week_start)::int AS carried_over,
         COUNT(*) FILTER (WHERE status != 'shot' AND scheduled_week_start = original_week_start)::int AS not_completed
       FROM shoot_schedule
       GROUP BY original_week_start
       ORDER BY original_week_start DESC`
    );
    res.json({ weeks: result.rows.map((w) => ({ ...w, week_start: dateStr(w.week_start) })) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
