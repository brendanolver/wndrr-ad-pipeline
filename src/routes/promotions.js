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
const URGENCY_RANK = { future: -1, on_track: 0, needs_attention: 1, at_risk: 2 };
const URGENCY_DUE_SOON_DAYS = 7;
const URGENCY_DUE_APPROACHING_DAYS = 21;
// ~2 months -- a stage with no due date of its own shouldn't warn the team
// the moment a far-future Promotion is created; it only starts mattering
// once the whole Promotion's launch is within this window (see B1).
const URGENCY_LAUNCH_WINDOW_DAYS = 60;

// Simple and transparent by design (per the spec): a stage with nothing
// still required is always On Track. Otherwise the closer its due date,
// the more a remaining gap matters. Campaign Stages don't get their own due
// date by default though (the common case), so a stage with none falls back
// to how close the whole Promotion is to launch -- a stage that's genuinely
// months away from mattering reads as a neutral "future/planned" state
// rather than a warning, only escalating once launch is within
// URGENCY_LAUNCH_WINDOW_DAYS. A stage with an explicit due date of its own
// keeps the tighter, more precise threshold since that's a real deadline
// someone set, not a fallback.
function stageUrgency(stillRequired, daysUntilDue, promotionDaysUntilLaunch) {
  if (stillRequired <= 0) return 'on_track';
  if (daysUntilDue != null) {
    if (daysUntilDue <= URGENCY_DUE_SOON_DAYS) return 'at_risk';
    if (daysUntilDue <= URGENCY_DUE_APPROACHING_DAYS) return 'needs_attention';
    return 'on_track';
  }
  if (promotionDaysUntilLaunch == null || promotionDaysUntilLaunch > URGENCY_LAUNCH_WINDOW_DAYS) return 'future';
  return promotionDaysUntilLaunch <= URGENCY_DUE_SOON_DAYS ? 'at_risk' : 'needs_attention';
}

// counts: { ready, planned } -- every shoot_plan_item linked to this stage
// is either "ready" (through qc/uploaded_live) or "planned" (committed into
// the workflow but not there yet), never both -- see the mutual-exclusivity
// comment on fetchStagesWithCoverage below. still_required subtracts BOTH --
// a requirement that already has a creative record moving through the
// pipeline (Planned) is no longer "still required" in the sense of needing
// someone to start one, even though it isn't Ready/Approved yet. When that
// same record later reaches Ready, it moves out of Planned and into Ready,
// so still_required is unchanged by the transition (see the "+ Shoot This
// Week" worked example: 20/0/1/19 -> 20/1/0/19).
function summarizeStage(stage, { ready = 0, planned = 0 } = {}, promotionDaysUntilLaunch = null) {
  const target = stage.required_count;
  const stillRequired = Math.max(0, target - ready - planned);
  const coveragePct = target > 0 ? Math.min(100, Math.round((ready / target) * 100)) : 100;
  const daysUntilDue = stage.due_date ? Math.ceil((new Date(stage.due_date) - new Date()) / 86400000) : null;
  const urgency = stageUrgency(stillRequired, daysUntilDue, promotionDaysUntilLaunch);

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
  // Each stage's own "planned" count is already the NOT-yet-ready portion of
  // its committed work (see the mutual-exclusivity comment on
  // fetchStagesWithCoverage below), so a plain sum keeps Ready + Planned +
  // Missing adding back up to Total Required for the progress-bar breakdown.
  const totalPlanned = stages.reduce((sum, s) => sum + s.planned, 0);
  const totalMissing = Math.max(0, totalRequired - totalReady - totalPlanned);
  const overallPct = totalRequired > 0 ? Math.round((totalReady / totalRequired) * 100) : null;
  const daysUntilLaunch = Math.ceil((new Date(promotion.start_date) - new Date()) / 86400000);
  // Drives the rolling major-sales calendar on the Promotions landing tab:
  // a promotion with no end_date is never "finished"; one with an end_date
  // in the past is -- separate from days_until_launch, which goes negative
  // the moment a sale STARTS even though it may still be actively running.
  const daysUntilEnd = promotion.end_date ? Math.ceil((new Date(promotion.end_date) - new Date()) / 86400000) : null;

  const onTrackCount = stages.filter((s) => s.urgency === 'on_track').length;
  const needsAttentionCount = stages.filter((s) => s.urgency === 'needs_attention').length;
  const atRiskCount = stages.filter((s) => s.urgency === 'at_risk').length;

  // A promotion's own status is the worst urgency among its still-short
  // stages -- one stage close to its deadline with a real gap matters more
  // than an okay-looking overall %. Zero stages reads as Needs Attention
  // (nothing organised yet), same convention this page has always used. A
  // gap stage's urgency is never 'on_track' (stageUrgency only returns that
  // when still_required <= 0), so the reduce starts at 'future' -- the
  // lowest rank -- rather than 'on_track', or a Promotion whose only gaps
  // are all comfortably far off would incorrectly read as "On Track"
  // instead of the neutral future/planned state (see B1).
  const gapStages = stages.filter((s) => s.still_required > 0);
  let status = 'on_track';
  if (!stages.length) status = 'needs_attention';
  else if (gapStages.length) {
    status = gapStages.reduce((worst, s) => (URGENCY_RANK[s.urgency] > URGENCY_RANK[worst] ? s.urgency : worst), 'future');
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
    days_until_end: daysUntilEnd,
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

async function fetchStagesWithCoverage(promotions) {
  const promotionIds = promotions.map((p) => p.id);
  if (!promotionIds.length) return new Map();
  const launchDaysByPromotion = new Map(
    promotions.map((p) => [p.id, Math.ceil((new Date(p.start_date) - new Date()) / 86400000)])
  );
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
    // A linked requirement is either Planned or Ready, never both -- once it
    // reaches a READY_STATUSES status it stops counting toward Planned.
    if (READY_STATUSES.has(row.status)) counts.ready += 1;
    else counts.planned += 1;
    countsByStage.set(row.promotion_stage_id, counts);
  }

  const stagesByPromotion = new Map();
  for (const stage of stagesResult.rows) {
    if (!stagesByPromotion.has(stage.promotion_id)) stagesByPromotion.set(stage.promotion_id, []);
    stagesByPromotion.get(stage.promotion_id).push(
      summarizeStage(stage, countsByStage.get(stage.id), launchDaysByPromotion.get(stage.promotion_id))
    );
  }
  return stagesByPromotion;
}

router.get('/', async (req, res, next) => {
  try {
    const promotionsResult = await pool.query('SELECT * FROM promotions ORDER BY start_date ASC');
    const promotions = promotionsResult.rows;
    const stagesByPromotion = await fetchStagesWithCoverage(promotions);
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

    const stagesByPromotion = await fetchStagesWithCoverage([promotion]);
    const stages = stagesByPromotion.get(promotion.id) || [];

    const stageIds = stages.map((s) => s.id);
    // ca.concept_name/concept_type/concept_assignee -- a Promotion item's
    // real identity and assignment live on its creative_assets row, not on
    // shoot_plan_items (spi.product_name/creator are the Core/High-Stock-era
    // "what product, which content creator" fields; a Promotion item has no
    // product, and spi.creator is Filming -- who's shooting it, see F --
    // never the concept-development Assigned To). Selecting these so the
    // stage card can show what the concept actually is (see C1) instead of
    // a person's name repeated on every row.
    const itemsResult = stageIds.length
      ? await pool.query(
          `SELECT spi.*, ca.status AS asset_status, ca.concept_name, ca.concept_type, ca.concept_assignee
           FROM shoot_plan_items spi
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
        concept_name: row.concept_name,
        concept_type: row.concept_type,
        concept_assignee: row.concept_assignee,
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

    const stagesByPromotion = await fetchStagesWithCoverage([result.rows[0]]);
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

    const promotion = await pool.query('SELECT id, start_date FROM promotions WHERE id = $1', [req.params.id]);
    if (!promotion.rows.length) return res.status(404).json({ error: 'Promotion not found' });

    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM promotion_stages WHERE promotion_id = $1',
      [req.params.id]
    );
    const result = await pool.query(
      `INSERT INTO promotion_stages (promotion_id, name, required_count, sort_order, due_date) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, name.trim(), count, maxOrder.rows[0].max_order + 1, due_date || null]
    );
    const daysUntilLaunch = Math.ceil((new Date(promotion.rows[0].start_date) - new Date()) / 86400000);
    res.status(201).json(summarizeStage(result.rows[0], {}, daysUntilLaunch));
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
      // Same mutual-exclusivity rule as fetchStagesWithCoverage above.
      if (READY_STATUSES.has(row.status)) counts.ready += 1;
      else counts.planned += 1;
    }
    const promotionResult = await pool.query('SELECT start_date FROM promotions WHERE id = $1', [current.promotion_id]);
    const daysUntilLaunch = Math.ceil((new Date(promotionResult.rows[0].start_date) - new Date()) / 86400000);
    res.json(summarizeStage(result.rows[0], counts, daysUntilLaunch));
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
