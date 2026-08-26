const express = require('express');
const { pool } = require('../db');
const { getWeekRange, formatWeekLabel } = require('../lib/week');

const router = express.Router();

// Sample/placeholder values: nothing in the schema yet tracks a weekly
// target, a concept-vs-variation split, or an "approved"/"changes
// requested" pipeline state (Phase 1's schema goes straight from QC to
// Uploaded/Live, and the Weekly Plan target itself doesn't exist until
// Phase 3). These are flagged with `sample: true` in the response so the
// frontend can mark them distinctly rather than passing them off as real.
const WEEKLY_TARGET = 30;
const NEW_CONCEPTS_TARGET = 8;
const NEW_CONCEPTS_ACTUAL_SAMPLE = 6;

router.get('/', async (req, res, next) => {
  try {
    const weekOffset = Number.parseInt(req.query.weekOffset, 10) || 0;
    const week = getWeekRange(weekOffset);

    const [shippedResult, stageCountsResult, overdueResult, avgProductionResult, staleResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT creative_asset_id)::int AS count
         FROM status_history
         WHERE to_status = 'uploaded_live' AND changed_at BETWEEN $1 AND $2`,
        [week.start, week.end]
      ),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM creative_assets GROUP BY status`),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM creative_assets
         WHERE target_date IS NOT NULL AND target_date < CURRENT_DATE AND status != 'uploaded_live'`
      ),
      pool.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (last_ship.changed_at - ca.created_at)) / 86400.0) AS avg_days
         FROM creative_assets ca
         JOIN LATERAL (
           SELECT changed_at FROM status_history sh
           WHERE sh.creative_asset_id = ca.id AND sh.to_status = 'uploaded_live'
           ORDER BY sh.changed_at DESC LIMIT 1
         ) last_ship ON true
         WHERE last_ship.changed_at >= now() - interval '30 days'`
      ),
      pool.query(
        `SELECT ca.status,
           (SELECT MAX(sh.changed_at) FROM status_history sh
            WHERE sh.creative_asset_id = ca.id AND sh.to_status = ca.status) AS stage_entered_at
         FROM creative_assets ca
         WHERE ca.status IN ('editing', 'qc')`
      ),
    ]);

    const stageCounts = Object.fromEntries(stageCountsResult.rows.map((r) => [r.status, r.count]));
    const briefing =
      (stageCounts.not_started || 0) + (stageCounts.awaiting_proven_concept || 0)
      + (stageCounts.awaiting_concept_development || 0) + (stageCounts.concept_script || 0);
    const inProduction = stageCounts.filming || 0;
    const editing = stageCounts.editing || 0;
    const awaitingReview = stageCounts.qc || 0;

    const shipped = shippedResult.rows[0].count;
    const overdue = overdueResult.rows[0].count;
    const avgProductionDays = avgProductionResult.rows[0].avg_days ? Number(avgProductionResult.rows[0].avg_days) : null;

    const now = Date.now();
    const editingStale = staleResult.rows.filter(
      (r) => r.status === 'editing' && r.stage_entered_at && now - new Date(r.stage_entered_at).getTime() > 2 * 86400000
    ).length;
    const qcStale = staleResult.rows.filter(
      (r) => r.status === 'qc' && r.stage_entered_at && now - new Date(r.stage_entered_at).getTime() > 86400000
    ).length;

    const planned = WEEKLY_TARGET;
    const remaining = Math.max(0, planned - shipped);
    const completionPct = planned > 0 ? Math.round((shipped / planned) * 100) : 0;

    const expectedProgress = week.daysElapsed / 7;
    const actualProgress = planned > 0 ? shipped / planned : 1;
    const progressDelta = actualProgress - expectedProgress;
    let weekStatus = 'on_track';
    if (week.daysElapsed > 0) {
      if (progressDelta < -0.3) weekStatus = 'off_track';
      else if (progressDelta < -0.1) weekStatus = 'at_risk';
    }

    res.json({
      week: {
        number: week.weekNumber,
        label: formatWeekLabel(week),
        daysRemaining: week.daysRemaining,
        offset: weekOffset,
      },
      current: {
        planned,
        shipped,
        remaining,
        completionPct,
        status: weekStatus,
        plannedIsSample: true,
      },
      pipeline: {
        planned: { count: planned, sample: true },
        briefing: { count: briefing },
        in_production: { count: inProduction },
        editing: { count: editing, stale: editingStale, staleNote: editingStale ? `${editingStale} waiting >2 days` : null },
        awaiting_review: { count: awaitingReview, stale: qcStale, staleNote: qcStale ? `${qcStale} waiting >24h` : null },
        changes: { count: null, note: 'Not tracked yet' },
        approved: { count: null, note: 'Not tracked yet — QC currently goes straight to Shipped' },
        shipped: { count: shipped },
      },
      health: {
        overdue,
        avgProductionDays,
        newConcepts: { actual: NEW_CONCEPTS_ACTUAL_SAMPLE, target: NEW_CONCEPTS_TARGET, sample: true },
        adVariations: { actual: shipped, target: planned, targetIsSample: true },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
