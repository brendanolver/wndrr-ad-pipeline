const express = require('express');
const { pool } = require('../db');
const { SHOOT_DAYS } = require('../lib/statuses');

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
const SUMMARY_SELECT = `
  SELECT
    ss.id, ss.creative_asset_id, ss.status, ss.original_week_start,
    ss.scheduled_week_start, ss.scheduled_day, ss.shot_at, ss.ready_for_editing,
    ca.concept_name, ca.location, ca.hook_variations,
    spi.product_name, spi.image_url, spi.creator AS owner, spi.source
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
         ca.concept_name, ca.angle, ca.execution, ca.script_notes, ca.hook_variations,
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
    if (brief.shoot_plan_item_id) {
      const stylesResult = await pool.query(
        `SELECT s.style_code, spis.colour_label, spis.size
         FROM shoot_plan_item_styles spis
         JOIN styles s ON s.id = spis.style_id
         WHERE spis.shoot_plan_item_id = $1`,
        [brief.shoot_plan_item_id]
      );
      colourways = stylesResult.rows;
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
    const nextStatus = nextDay ? 'scheduled' : 'unscheduled';

    const result = await pool.query(
      `UPDATE shoot_schedule SET
         scheduled_day = $1::varchar,
         scheduled_week_start = COALESCE($2::date, scheduled_week_start),
         status = $3::varchar,
         updated_at = now()
       WHERE id = $4 AND status != 'shot'
       RETURNING *`,
      [nextDay, scheduled_week_start || null, nextStatus, req.params.id]
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

// The one production action Shooting has -- must already be Scheduled to a
// day (shooting happens on a specific day). Sets Ready for Editing so the
// next stage can pick it up later; nothing about Editing is built here.
router.post('/:id/mark-shot', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE shoot_schedule SET
         status = 'shot',
         shot_at = now(),
         ready_for_editing = true,
         updated_at = now()
       WHERE id = $1 AND status = 'scheduled'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) {
      const existsResult = await pool.query('SELECT id, status FROM shoot_schedule WHERE id = $1', [req.params.id]);
      if (!existsResult.rows.length) return res.status(404).json({ error: 'Shoot schedule entry not found' });
      return res.status(409).json({ error: `Only a Scheduled Concept can be marked Shot (this one is ${existsResult.rows[0].status})` });
    }
    const row = result.rows[0];
    res.json({ ...row, original_week_start: dateStr(row.original_week_start), scheduled_week_start: dateStr(row.scheduled_week_start) });
  } catch (err) {
    next(err);
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
