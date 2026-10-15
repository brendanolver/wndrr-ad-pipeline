// Production-pipeline counts for the Dashboard's pipeline strip and "Needs
// attention" list. Read-only and additive: the legacy `pipeline`/`health`
// blocks in routes/dashboard.js are untouched.
//
// Stage meaning (all counted from the workflow tables the stage pages
// themselves read, so a Dashboard figure always matches the page it links to):
//   concept_development  concepts in the selected week still being developed
//                        (not_started / in_development / changes_required)
//   tuesday_review       concepts in the selected week ready_for_review
//   shooting             shoots not yet shot (unscheduled or scheduled) for the selected week
//   editing              shot concepts whose Final Edit has not been submitted (live queue)
//   final_approval       submitted and still awaiting a decision (live queue)
// Attention items are live (not week-bound) because overdue work carries over.

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const EDITING_STALE_DAYS = 2;
const APPROVAL_STALE_HOURS = 24;

async function loadWorkflowCounts(pool, weekStart, today = new Date()) {
  const monday = typeof weekStart === 'string' ? weekStart : localDateStr(weekStart);
  const todayStr = typeof today === 'string' ? today : localDateStr(today);

  const [concepts, shoots, queues, overdue] = await Promise.all([
    pool.query(
      `SELECT ca.concept_dev_status AS s, COUNT(*)::int AS n
       FROM creative_assets ca
       JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
       WHERE spi.week_start = $1::date
         AND ca.archived_at IS NULL
         AND ca.concept_dev_status IN ('not_started', 'in_development', 'changes_required', 'ready_for_review')
       GROUP BY ca.concept_dev_status`,
      [monday]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM shoot_schedule ss
       JOIN creative_assets ca ON ca.id = ss.creative_asset_id
       WHERE ss.scheduled_week_start = $1::date AND ss.status IN ('unscheduled', 'scheduled')
         AND ca.concept_dev_status = 'approved' AND ca.archived_at IS NULL`,
      [monday]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ss.status = 'shot' AND ca.editing_submitted_at IS NULL)::int AS editing,
         COUNT(*) FILTER (WHERE ss.status = 'shot' AND ca.editing_submitted_at IS NULL
                          AND ss.shot_at < now() - ($1 || ' days')::interval)::int AS editing_stale,
         COUNT(*) FILTER (WHERE ca.editing_submitted_at IS NOT NULL AND ca.final_approval_status = 'pending')::int AS approval,
         COUNT(*) FILTER (WHERE ca.editing_submitted_at IS NOT NULL AND ca.final_approval_status = 'pending'
                          AND ca.editing_submitted_at < now() - ($2 || ' hours')::interval)::int AS approval_stale
       FROM creative_assets ca
       LEFT JOIN shoot_schedule ss ON ss.creative_asset_id = ca.id
       WHERE ca.archived_at IS NULL AND ca.concept_dev_status <> 'killed'`,
      [String(EDITING_STALE_DAYS), String(APPROVAL_STALE_HOURS)]
    ),
    // A scheduled shoot is overdue once its scheduled weekday is before today.
    pool.query(
      `SELECT COUNT(*)::int AS n FROM shoot_schedule ss
       JOIN creative_assets ca ON ca.id = ss.creative_asset_id
       WHERE ss.status = 'scheduled' AND ss.scheduled_day IS NOT NULL
         AND ca.concept_dev_status = 'approved' AND ca.archived_at IS NULL
         AND ss.scheduled_week_start + (CASE ss.scheduled_day
               WHEN 'monday' THEN 0 WHEN 'tuesday' THEN 1 WHEN 'wednesday' THEN 2
               WHEN 'thursday' THEN 3 ELSE 4 END) < $1::date`,
      [todayStr]
    ),
  ]);

  const byStatus = Object.fromEntries(concepts.rows.map((r) => [r.s, r.n]));
  const q = queues.rows[0];
  return {
    week_start: monday,
    concept_development: (byStatus.not_started || 0) + (byStatus.in_development || 0) + (byStatus.changes_required || 0),
    tuesday_review: byStatus.ready_for_review || 0,
    shooting: shoots.rows[0].n,
    editing: q.editing,
    final_approval: q.approval,
    attention: {
      concepts_awaiting_review: byStatus.ready_for_review || 0,
      overdue_shoots: overdue.rows[0].n,
      editing_backlog: q.editing_stale,
      editing_backlog_days: EDITING_STALE_DAYS,
      awaiting_approval: q.approval,
      awaiting_approval_stale: q.approval_stale,
    },
  };
}

module.exports = { loadWorkflowCounts, localDateStr, EDITING_STALE_DAYS, APPROVAL_STALE_HOURS };
