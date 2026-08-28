const express = require('express');
const { pool } = require('../db');
const { coverageStatus } = require('../lib/coverage');
const { STATUS_LABELS } = require('../lib/statuses');

const router = express.Router();

// Mirrors drops.js's rewriteRanks/summarize/sortByUrgency -- Promotions
// reuses Upcoming Drops' own shape (a numeric target vs current coverage
// per requirement, rolled up into a green/amber/red summary and a "most
// urgent" shortlist) so the two pages read the same way, just with Campaign
// Stages standing in for Products.
function summarizeStage(stage, covered) {
  return {
    ...stage,
    covered,
    remaining: Math.max(0, stage.required_count - covered),
    status: coverageStatus(covered, stage.required_count),
  };
}

function summarizePromotion(promotion, stages) {
  const green = stages.filter((s) => s.status === 'green').length;
  const amber = stages.filter((s) => s.status === 'amber').length;
  const red = stages.filter((s) => s.status === 'red').length;
  const totalCovered = stages.reduce((sum, s) => sum + s.covered, 0);
  const totalTarget = stages.reduce((sum, s) => sum + s.required_count, 0);
  const overallPct = totalTarget > 0 ? Math.round((totalCovered / totalTarget) * 100) : null;
  const mostUrgent = [...stages].filter((s) => s.remaining > 0).sort((a, b) => b.remaining - a.remaining).slice(0, 3);
  const daysUntilLaunch = Math.ceil((new Date(promotion.start_date) - new Date()) / 86400000);
  // Same "reads as Needs Attention until proven otherwise" rule as Drops:
  // zero stages (nothing organised yet) or any stage still short is Needs
  // Attention; only every stage fully covered is On Track.
  const onTrack = stages.length > 0 && stages.every((s) => s.status === 'green');

  return {
    ...promotion,
    days_until_launch: daysUntilLaunch,
    stages,
    summary: { stageCount: stages.length, green, amber, red, totalCovered, totalTarget, overallPct },
    most_urgent: mostUrgent,
    status: onTrack ? 'on_track' : 'needs_attention',
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
        `SELECT promotion_stage_id, COUNT(*)::int AS count FROM shoot_plan_items
         WHERE promotion_stage_id = ANY($1::int[]) GROUP BY promotion_stage_id`,
        [stageIds]
      )
    : { rows: [] };
  const coveredByStage = new Map(coveredResult.rows.map((r) => [r.promotion_stage_id, r.count]));

  const stagesByPromotion = new Map();
  for (const stage of stagesResult.rows) {
    if (!stagesByPromotion.has(stage.promotion_id)) stagesByPromotion.set(stage.promotion_id, []);
    stagesByPromotion.get(stage.promotion_id).push(summarizeStage(stage, coveredByStage.get(stage.id) || 0));
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
    const { name, required_count } = req.body || {};
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
      `INSERT INTO promotion_stages (promotion_id, name, required_count, sort_order) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, name.trim(), count, maxOrder.rows[0].max_order + 1]
    );
    res.status(201).json(summarizeStage(result.rows[0], 0));
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
    const { name, required_count } = req.body || {};
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

    const result = await pool.query(
      `UPDATE promotion_stages SET name = $1, required_count = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [nextName, nextCount, req.params.stageId]
    );
    const coveredResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM shoot_plan_items WHERE promotion_stage_id = $1',
      [req.params.stageId]
    );
    res.json(summarizeStage(result.rows[0], coveredResult.rows[0].count));
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
