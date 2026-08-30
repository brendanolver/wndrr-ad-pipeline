const express = require('express');
const { pool } = require('../db');
const { STATUS_LABELS } = require('../lib/statuses');

const router = express.Router();

// "Ready" means approved and genuinely usable, not merely committed to the
// workflow -- qc is included alongside uploaded_live because a promotion is
// planned ahead of its launch, so nothing can be literally live yet for
// most of the time it matters. See summarizeStage below for why this is
// kept separate from "Planned" rather than folded into one coverage count
// (the bug this whole redesign replaces: counting any linked item as
// "covered" regardless of status).
const READY_STATUSES = new Set(['qc', 'uploaded_live']);
const URGENCY_RANK = { at_risk: 2, needs_attention: 1, on_track: 0 };
const URGENCY_DUE_SOON_DAYS = 7;
const URGENCY_DUE_APPROACHING_DAYS = 21;

// Simple and transparent by design (per the spec): a stage with nothing
// still required is always On Track. Otherwise the closer its due date,
// the more a remaining gap matters -- a stage with no due date set can't be
// judged by closeness at all, so it defaults to Needs Attention rather than
// silently reading as fine.
function stageUrgency(stillRequired, daysUntilDue) {
  if (stillRequired <= 0) return 'on_track';
  if (daysUntilDue == null) return 'needs_attention';
  if (daysUntilDue <= URGENCY_DUE_SOON_DAYS) return 'at_risk';
  if (daysUntilDue <= URGENCY_DUE_APPROACHING_DAYS) return 'needs_attention';
  return 'on_track';
}

// counts: { ready, planned } -- planned is EVERY shoot_plan_item linked to
// this stage regardless of status ("committed into the workflow"), ready is
// the ones through qc/uploaded_live. still_required (not "planned") is what
// drives urgency and the headline gap badge -- per the spec, planned
// creative is never treated as fully covering the requirement.
function summarizeStage(stage, { ready = 0, planned = 0 } = {}) {
  const target = stage.required_count;
  const stillRequired = Math.max(0, target - ready);
  const coveragePct = target > 0 ? Math.min(100, Math.round((ready / target) * 100)) : 100;
  const daysUntilDue = stage.due_date ? Math.ceil((new Date(stage.due_date) - new Date()) / 86400000) : null;
  const urgency = stageUrgency(stillRequired, daysUntilDue);

  return {
    ...stage,
    target,
    ready,
    planned,
    still_required: stillRequired,
    coverage_pct: coveragePct,
    days_until_due: daysUntilDue,
    urgency,
  };
}

function summarizePromotion(promotion, stages) {
  const totalRequired = stages.reduce((sum, s) => sum + s.target, 0);
  const totalReady = stages.reduce((sum, s) => sum + s.ready, 0);
  // The overview's "Planned" bucket is deliberately the NOT-yet-ready
  // portion of each stage's committed work (not each stage's own raw
  // "planned" count, which includes its ready items too) -- so Ready +
  // Planned + Missing always adds back up to Total Required for the
  // progress-bar breakdown, matching the spec's own worked example.
  const totalPlanned = stages.reduce((sum, s) => sum + Math.max(0, s.planned - s.ready), 0);
  const totalMissing = Math.max(0, totalRequired - totalReady - totalPlanned);
  const overallPct = totalRequired > 0 ? Math.round((totalReady / totalRequired) * 100) : null;
  const daysUntilLaunch = Math.ceil((new Date(promotion.start_date) - new Date()) / 86400000);

  const onTrackCount = stages.filter((s) => s.urgency === 'on_track').length;
  const needsAttentionCount = stages.filter((s) => s.urgency === 'needs_attention').length;
  const atRiskCount = stages.filter((s) => s.urgency === 'at_risk').length;

  // A promotion's own status is the worst urgency among its still-short
  // stages -- one stage close to its deadline with a real gap matters more
  // than an okay-looking overall %. Zero stages reads as Needs Attention
  // (nothing organised yet), same convention this page has always used.
  const gapStages = stages.filter((s) => s.still_required > 0);
  let status = 'on_track';
  if (!stages.length) status = 'needs_attention';
  else if (gapStages.length) {
    status = gapStages.reduce((worst, s) => (URGENCY_RANK[s.urgency] > URGENCY_RANK[worst] ? s.urgency : worst), 'on_track');
  }

  // "Next priority" / "Most urgent stage": worst urgency first, then
  // whichever due date is soonest, then the largest remaining gap --
  // stages with no due date sort last among equally-urgent ones since
  // there's no deadline pressure to point at.
  const mostUrgentStage = [...gapStages].sort((a, b) => {
    const rankDiff = URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency];
    if (rankDiff !== 0) return rankDiff;
    if (a.days_until_due == null && b.days_until_due == null) return b.still_required - a.still_required;
    if (a.days_until_due == null) return 1;
    if (b.days_until_due == null) return -1;
    return a.days_until_due - b.days_until_due;
  })[0] || null;

  return {
    ...promotion,
    days_until_launch: daysUntilLaunch,
    stages,
    summary: {
      stage_count: stages.length,
      total_required: totalRequired,
      total_ready: totalReady,
      total_planned: totalPlanned,
      total_missing: totalMissing,
      overall_pct: overallPct,
      on_track_count: onTrackCount,
      needs_attention_count: needsAttentionCount,
      at_risk_count: atRiskCount,
    },
    most_urgent_stage: mostUrgentStage,
    status,
  };
}

async function fetchStagesWithCoverage(promotionIds) {
  if (!promotionIds.length) return new Map();
  const stagesResult = await pool.query(
    'SELECT * FROM promotion_stages WHERE promotion_id = ANY($1::int[]) ORDER BY sort_order ASC, id ASC',
    [promotionIds]
  );
  const stageIds = stagesResult.rows.map((s) => s.id);
  const coveredResult = stageIds.length
    ? await pool.query(
        `SELECT spi.promotion_stage_id, ca.status FROM shoot_plan_items spi
         LEFT JOIN creative_assets ca ON ca.id = spi.asset_id
         WHERE spi.promotion_stage_id = ANY($1::int[])`,
        [stageIds]
      )
    : { rows: [] };
  const countsByStage = new Map();
  for (const row of coveredResult.rows) {
    const counts = countsByStage.get(row.promotion_stage_id) || { ready: 0, planned: 0 };
    counts.planned += 1;
    if (READY_STATUSES.has(row.status)) counts.ready += 1;
    countsByStage.set(row.promotion_stage_id, counts);
  }

  const stagesByPromotion = new Map();
  for (const stage of stagesResult.rows) {
    if (!stagesByPromotion.has(stage.promotion_id)) stagesByPromotion.set(stage.promotion_id, []);
    stagesByPromotion.get(stage.promotion_id).push(summarizeStage(stage, countsByStage.get(stage.id)));
  }
  return stagesByPromotion;
}

router.get('/', async (req, res, next) => {
  try {
    const promotionsResult = await pool.query('SELECT * FROM promotions ORDER BY start_date ASC');
    const promotions = promotionsResult.rows;
    const stagesByPromotion = await fetchStagesWithCoverage(promotions.map((p) => p.id));
    res.json(promotions.map((p) => summarizePromotion(p, stagesByPromotion.get(p.id) || [])));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, start_date, end_date, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!start_date) return res.status(400).json({ error: 'start_date is required' });

    const result = await pool.query(
      'INSERT INTO promotions (name, start_date, end_date, notes) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.trim(), start_date, end_date || null, notes && notes.trim() ? notes.trim() : null]
    );
    res.status(201).json(summarizePromotion(result.rows[0], []));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const promotionResult = await pool.query('SELECT * FROM promotions WHERE id = $1', [req.params.id]);
    if (!promotionResult.rows.length) return res.status(404).json({ error: 'Promotion not found' });
    const promotion = promotionResult.rows[0];

    const stagesByPromotion = await fetchStagesWithCoverage([promotion.id]);
    const stages = stagesByPromotion.get(promotion.id) || [];

    const stageIds = stages.map((s) => s.id);
    const itemsResult = stageIds.length
      ? await pool.query(
          `SELECT spi.*, ca.status AS asset_status FROM shoot_plan_items spi
           LEFT JOIN creative_assets ca ON ca.id = spi.asset_id
           WHERE spi.promotion_stage_id = ANY($1::int[]) ORDER BY spi.created_at ASC`,
          [stageIds]
        )
      : { rows: [] };
    const itemsByStage = new Map();
    for (const row of itemsResult.rows) {
      if (!itemsByStage.has(row.promotion_stage_id)) itemsByStage.set(row.promotion_stage_id, []);
      itemsByStage.get(row.promotion_stage_id).push({
        id: row.id,
        asset_id: row.asset_id,
        product_code: row.product_code,
        product_name: row.product_name,
        creator: row.creator,
        asset_status: row.asset_status,
        asset_status_label: row.asset_status ? (STATUS_LABELS[row.asset_status] || row.asset_status) : null,
        created_at: row.created_at,
      });
    }
    const stagesWithItems = stages.map((s) => ({ ...s, items: itemsByStage.get(s.id) || [] }));

    res.json(summarizePromotion(promotion, stagesWithItems));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, start_date, end_date, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!start_date) return res.status(400).json({ error: 'start_date is required' });

    const result = await pool.query(
      `UPDATE promotions SET name = $1, start_date = $2, end_date = $3, notes = $4, updated_at = now() WHERE id = $5 RETURNING *`,
      [name.trim(), start_date, end_date || null, notes && notes.trim() ? notes.trim() : null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Promotion not found' });

    const stagesByPromotion = await fetchStagesWithCoverage([result.rows[0].id]);
    res.json(summarizePromotion(result.rows[0], stagesByPromotion.get(result.rows[0].id) || []));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM promotions WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Promotion not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Campaign Stages: fully custom per promotion (add/rename/delete/
// reorder/required count) -- never a fixed Hype/Launch/Mid-Sale/Last Chance
// set, since different campaigns need different structures. ──

router.post('/:id/stages', async (req, res, next) => {
  try {
    const { name, required_count, due_date } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const count = required_count === undefined ? 1 : Number(required_count);
    if (!Number.isFinite(count) || count < 0) return res.status(400).json({ error: 'required_count must be a non-negative number' });

    const promotion = await pool.query('SELECT id FROM promotions WHERE id = $1', [req.params.id]);
    if (!promotion.rows.length) return res.status(404).json({ error: 'Promotion not found' });

    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM promotion_stages WHERE promotion_id = $1',
      [req.params.id]
    );
    const result = await pool.query(
      `INSERT INTO promotion_stages (promotion_id, name, required_count, sort_order, due_date) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, name.trim(), count, maxOrder.rows[0].max_order + 1, due_date || null]
    );
    res.status(201).json(summarizeStage(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// Registered before PUT /:id-shaped routes below so "/stages/reorder" isn't
// shadowed as a stage :stageId param (same convention provenWinners.js's
// PUT /reorder follows ahead of PUT /:id).
router.put('/stages/reorder', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { ordered_ids } = req.body || {};
    if (!Array.isArray(ordered_ids) || !ordered_ids.length) {
      return res.status(400).json({ error: 'ordered_ids is required' });
    }
    await client.query('BEGIN');
    for (let i = 0; i < ordered_ids.length; i += 1) {
      await client.query('UPDATE promotion_stages SET sort_order = $1, updated_at = now() WHERE id = $2', [i, ordered_ids[i]]);
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

router.put('/stages/:stageId', async (req, res, next) => {
  try {
    const { name, required_count, due_date } = req.body || {};
    const existing = await pool.query('SELECT * FROM promotion_stages WHERE id = $1', [req.params.stageId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Stage not found' });
    const current = existing.rows[0];

    const nextName = name !== undefined && name.trim() ? name.trim() : current.name;
    let nextCount = current.required_count;
    if (required_count !== undefined) {
      const count = Number(required_count);
      if (!Number.isFinite(count) || count < 0) return res.status(400).json({ error: 'required_count must be a non-negative number' });
      nextCount = count;
    }
    // Explicit-clear supported, same as PUT /drops/:id's end_date: sending
    // due_date: null (or '') removes it, omitting the key leaves it as-is.
    const nextDueDate = due_date !== undefined ? (due_date || null) : current.due_date;

    const result = await pool.query(
      `UPDATE promotion_stages SET name = $1, required_count = $2, due_date = $3, updated_at = now() WHERE id = $4 RETURNING *`,
      [nextName, nextCount, nextDueDate, req.params.stageId]
    );
    const coveredResult = await pool.query(
      `SELECT ca.status FROM shoot_plan_items spi
       LEFT JOIN creative_assets ca ON ca.id = spi.asset_id
       WHERE spi.promotion_stage_id = $1`,
      [req.params.stageId]
    );
    const counts = { ready: 0, planned: 0 };
    for (const row of coveredResult.rows) {
      counts.planned += 1;
      if (READY_STATUSES.has(row.status)) counts.ready += 1;
    }
    res.json(summarizeStage(result.rows[0], counts));
  } catch (err) {
    next(err);
  }
});

router.delete('/stages/:stageId', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM promotion_stages WHERE id = $1 RETURNING id', [req.params.stageId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Stage not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
