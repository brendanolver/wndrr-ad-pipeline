const express = require('express');
const { pool } = require('../db');
const { fetchAmData, getRules } = require('../lib/planningData');
const { buildCoverage } = require('../lib/coverage');
const { deriveProductCode } = require('../lib/apparelmagic');

const router = express.Router();

// "Products" have no table of their own -- they're a derived grouping of a
// drop's styles by shared 8-char product code (same as coverage.js). This
// recomputes the live creative_target for one product the exact same way
// the Drop coverage grid does, so the two always agree.
async function computeProductTarget(dropId, productCode) {
  const stylesResult = await pool.query('SELECT * FROM styles WHERE drop_id = $1', [dropId]);
  const matching = stylesResult.rows.filter((s) => deriveProductCode(s.style_code) === productCode);
  if (!matching.length) return { found: false, target: null };

  const [rules, am] = await Promise.all([getRules(), fetchAmData()]);
  const coverage = buildCoverage(matching, {
    assetCounts: new Map(),
    amStock: am.amStock,
    amOnOrder: am.amOnOrder,
    amDetails: am.amDetails,
    rules,
  });
  return { found: true, target: coverage[0] ? coverage[0].creative_target : null };
}

async function fetchPlanWithSlots(planId) {
  const planResult = await pool.query('SELECT * FROM drop_product_plans WHERE id = $1', [planId]);
  if (!planResult.rows.length) return null;
  const slotsResult = await pool.query(
    `SELECT s.*, ca.id AS asset_id, ca.concept_name AS asset_concept_name, ca.status AS asset_status,
            ca.concept_classification AS asset_classification, ca.format AS asset_format,
            sty.style_code AS asset_style_code
     FROM drop_product_plan_slots s
     LEFT JOIN creative_assets ca ON ca.id = s.fulfilled_by_asset_id
     LEFT JOIN styles sty ON sty.id = ca.style_id
     WHERE s.plan_id = $1 ORDER BY s.slot_rank ASC`,
    [planId]
  );
  return { plan: planResult.rows[0], slots: slotsResult.rows };
}

router.get('/', async (req, res, next) => {
  try {
    const dropId = Number(req.query.drop_id);
    const productCode = req.query.product_code;
    if (!dropId || !productCode) return res.status(400).json({ error: 'drop_id and product_code are required' });

    const { found, target } = await computeProductTarget(dropId, productCode);
    if (!found) return res.status(404).json({ error: 'Product not found in this drop' });

    const planRow = await pool.query(
      'SELECT id FROM drop_product_plans WHERE drop_id = $1 AND product_code = $2',
      [dropId, productCode]
    );
    if (!planRow.rows.length) {
      return res.json({ plan: null, slots: [], target, shortfall: target });
    }
    const { plan, slots } = await fetchPlanWithSlots(planRow.rows[0].id);
    const shortfall = target != null ? Math.max(0, target - slots.length) : null;
    res.json({ plan, slots, target, shortfall });
  } catch (err) {
    next(err);
  }
});

// Server-authoritative generate-or-top-up. Idempotent: safe to call on every
// product view. Only ever APPENDS new slots (from currently-active Proven
// Winners not already used on this plan) up to the live target -- existing
// slots are never edited, reordered, or removed, so a later playbook edit
// (rename/reorder/deactivate/delete) can never rewrite committed work.
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { drop_id, product_code } = req.body || {};
    if (!drop_id || !product_code) return res.status(400).json({ error: 'drop_id and product_code are required' });

    const { found, target } = await computeProductTarget(drop_id, product_code);
    if (!found) return res.status(404).json({ error: 'Product not found in this drop' });
    if (target == null) {
      return res.json({ plan: null, slots: [], target: null, shortfall: null, reason: 'stock_unavailable' });
    }

    await client.query('BEGIN');
    const upserted = await client.query(
      `INSERT INTO drop_product_plans (drop_id, product_code, last_known_target)
       VALUES ($1, $2, $3)
       ON CONFLICT (drop_id, product_code)
       DO UPDATE SET last_known_target = EXCLUDED.last_known_target, updated_at = now()
       RETURNING id`,
      [drop_id, product_code, target]
    );
    const planId = upserted.rows[0].id;

    const existingSlots = await client.query(
      `SELECT slot_rank, proven_winner_id FROM drop_product_plan_slots WHERE plan_id = $1`,
      [planId]
    );
    const existingCount = existingSlots.rows.length;
    const usedPwIds = existingSlots.rows.map((r) => r.proven_winner_id).filter((id) => id != null);

    if (existingCount < target) {
      const need = target - existingCount;
      const pwResult = await client.query(
        `SELECT id, name, default_format, default_classification FROM proven_winners
         WHERE active AND NOT (id = ANY($1::int[])) ORDER BY rank ASC LIMIT $2`,
        [usedPwIds, need]
      );
      let nextRank = existingCount + 1;
      for (const pw of pwResult.rows) {
        await client.query(
          `INSERT INTO drop_product_plan_slots
            (plan_id, slot_rank, source, concept_name, proven_winner_id, default_format, default_classification)
           VALUES ($1, $2, 'proven', $3, $4, $5, $6)`,
          [planId, nextRank, pw.name, pw.id, pw.default_format, pw.default_classification]
        );
        nextRank += 1;
      }
    }

    await client.query('COMMIT');

    const { plan, slots } = await fetchPlanWithSlots(planId);
    res.status(201).json({ plan, slots, target, shortfall: Math.max(0, target - slots.length) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/slots', async (req, res, next) => {
  try {
    const { concept_name, description } = req.body || {};
    if (!concept_name || !concept_name.trim()) return res.status(400).json({ error: 'concept_name is required' });

    const planCheck = await pool.query('SELECT id FROM drop_product_plans WHERE id = $1', [req.params.id]);
    if (!planCheck.rows.length) return res.status(404).json({ error: 'Plan not found' });

    const maxRank = await pool.query(
      'SELECT COALESCE(MAX(slot_rank), 0) AS max_rank FROM drop_product_plan_slots WHERE plan_id = $1',
      [req.params.id]
    );
    const nextRank = maxRank.rows[0].max_rank + 1;

    await pool.query(
      `INSERT INTO drop_product_plan_slots (plan_id, slot_rank, source, concept_name, description)
       VALUES ($1, $2, 'new', $3, $4)`,
      [req.params.id, nextRank, concept_name.trim(), description || null]
    );

    const data = await fetchPlanWithSlots(req.params.id);
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/slots/:slotId', async (req, res, next) => {
  try {
    const slot = await pool.query(
      'SELECT * FROM drop_product_plan_slots WHERE id = $1 AND plan_id = $2',
      [req.params.slotId, req.params.id]
    );
    if (!slot.rows.length) return res.status(404).json({ error: 'Slot not found' });
    const row = slot.rows[0];
    if (row.source !== 'new') {
      return res.status(409).json({ error: 'Only manually-added New/Test concept slots can be removed' });
    }
    if (row.fulfilled_by_asset_id) {
      return res.status(409).json({ error: 'Unlink the fulfilling creative asset before removing this slot' });
    }

    await pool.query('DELETE FROM drop_product_plan_slots WHERE id = $1', [req.params.slotId]);
    const data = await fetchPlanWithSlots(req.params.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Link an EXISTING creative asset (e.g. one already made from the ordinary
// Kanban board before this product had a plan) to an open slot, without
// creating a new asset.
router.patch('/:id/slots/:slotId/fulfill', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { asset_id } = req.body || {};
    if (!asset_id) return res.status(400).json({ error: 'asset_id is required' });

    await client.query('BEGIN');
    const slot = await client.query(
      'SELECT * FROM drop_product_plan_slots WHERE id = $1 AND plan_id = $2 FOR UPDATE',
      [req.params.slotId, req.params.id]
    );
    if (!slot.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Slot not found' });
    }
    if (slot.rows[0].fulfilled_by_asset_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot is already fulfilled' });
    }

    const planResult = await client.query('SELECT * FROM drop_product_plans WHERE id = $1', [req.params.id]);
    if (!planResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Plan not found' });
    }
    const { drop_id: dropId, product_code: productCode } = planResult.rows[0];

    const asset = await client.query(
      `SELECT ca.id, s.style_code FROM creative_assets ca JOIN styles s ON s.id = ca.style_id
       WHERE ca.id = $1 AND s.drop_id = $2`,
      [asset_id, dropId]
    );
    if (!asset.rows.length || deriveProductCode(asset.rows[0].style_code) !== productCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'asset_id does not belong to a style in this product' });
    }

    await client.query('UPDATE drop_product_plan_slots SET fulfilled_by_asset_id = $1 WHERE id = $2', [
      asset_id,
      req.params.slotId,
    ]);
    await client.query('COMMIT');

    const data = await fetchPlanWithSlots(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/slots/:slotId/fulfill', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE drop_product_plan_slots SET fulfilled_by_asset_id = NULL WHERE id = $1 AND plan_id = $2 RETURNING id`,
      [req.params.slotId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Slot not found' });
    const data = await fetchPlanWithSlots(req.params.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
